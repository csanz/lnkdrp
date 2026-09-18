/**
 * Project metrics: the two aggregates a project has and a document does not
 * (`src/lib/analytics/project/pipelines.ts`), and the identity rule underneath both of them
 * (`src/lib/analytics/project/viewerKey.ts`).
 *
 * Nothing here needs a database, and that is deliberate: these expressions fail *silently* when
 * they are wrong. A bad field reference yields `null`, the route's `?? 0` turns it into a zero, and
 * the metrics page renders a confident wrong number with no error anywhere — which is exactly how
 * the project view shipped its first pass claiming twice the recipients it had. So the tests pin
 * three things: the field names the pipelines reference, the arithmetic the shapers perform, and
 * the reconciliation identity that the page's own layout asserts by putting the per-link column
 * directly under the totals tile.
 */
import { describe, expect, test } from "vitest";

import {
  byDocPipeline,
  landingsPipeline,
  readLandingRollup,
  shapeByDoc,
  viewsByDayPipeline,
} from "@/lib/analytics/project/pipelines";
import { PROJECT_ANON_KEY_EXPR, PROJECT_LINK_VIEWER_KEY_EXPR } from "@/lib/analytics/project/viewerKey";
import { LINK_VIEWER_KEY_EXPR, RECIPIENT_ONLY_MATCH, windowStartUtc } from "@/lib/analytics/shareViewAggregates";

/** Every `"$field"` reference anywhere inside an aggregation expression (not `"$$var"`). */
function fieldRefs(node: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (typeof node === "string") {
    if (node.startsWith("$") && !node.startsWith("$$")) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) fieldRefs(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Operator keys ("$sum") are not field references; their values may be.
      if (!k.startsWith("$")) fieldRefs(k, out);
      fieldRefs(v, out);
    }
  }
  return out;
}

const START = windowStartUtc(15, new Date("2026-09-17T12:00:00.000Z"));

describe("the project viewer key", () => {
  /**
   * The bug this pins cost the first pass its numbers: a project link writes
   * `botIdHash = "<sha256>.<docId>"` so one row can exist per document, and keying viewers on the
   * whole string counted one investor reading two files as two recipients.
   */
  test("anonymous identity is the digest, not the digest-plus-document composite", () => {
    expect(PROJECT_ANON_KEY_EXPR).toEqual({ $substrCP: [{ $ifNull: ["$botIdHash", ""] }, 0, 64] });
  });

  test("it is shaped like the document key, so both routes group the same way", () => {
    expect(Object.keys(PROJECT_LINK_VIEWER_KEY_EXPR)).toEqual(Object.keys(LINK_VIEWER_KEY_EXPR));
    expect(PROJECT_LINK_VIEWER_KEY_EXPR.shareId).toBe("$shareId");
  });

  test("it differs from the document key in exactly one place — the anonymous branch", () => {
    // If these ever became equal, either the composite ingest changed or someone "simplified" the
    // project route back onto the document expression, which is the regression to catch.
    expect(JSON.stringify(PROJECT_LINK_VIEWER_KEY_EXPR)).not.toBe(JSON.stringify(LINK_VIEWER_KEY_EXPR));
    expect(fieldRefs(PROJECT_LINK_VIEWER_KEY_EXPR)).toEqual(fieldRefs(LINK_VIEWER_KEY_EXPR));
  });
});

describe("landingsPipeline", () => {
  const pipeline = landingsPipeline({ shareId: { $in: ["a", "b"] }, ...RECIPIENT_ONLY_MATCH }, START);

  test("keeps the caller's scope and adds the shared activity window", () => {
    const match = (pipeline[0] as { $match: Record<string, unknown> }).$match;
    expect(match.shareId).toEqual({ $in: ["a", "b"] });
    // The owner's own landings are recorded and never counted — the same bargain ShareView strikes.
    expect(match.isOwnerPreview).toEqual({ $ne: true });
    expect(match.$or).toEqual([{ lastViewedAt: { $gte: START } }, { lastViewedAt: null, updatedDate: { $gte: START } }]);
  });

  test("reads only fields ProjectLinkView actually has", () => {
    const refs = fieldRefs(pipeline.slice(1));
    expect(refs).toEqual(new Set(["$landingsByDay", "$docsOpened", "$visits", "$windowLandings"]));
  });

  /**
   * The finding this pins: `visits` is a **cumulative** counter and `activityWindowMatch` selects
   * rows by *last* activity, so summing it put a recipient's entire history into whatever window
   * was asked for — someone who landed forty times over six months and came back today contributed
   * all forty to a `days=3` response. Landings are summed per day now, the same way downloads
   * always were.
   */
  test("landings come from the per-day map, never from the cumulative visits counter", () => {
    const json = JSON.stringify(pipeline);
    expect(json).toContain("$landingsByDay");
    expect((pipeline[2] as { $group: Record<string, unknown> }).$group.landings).toEqual({ $sum: "$windowLandings" });
    // `visits` appears exactly once, and only as the *legacy-row test* below — never summed.
    const proj = (pipeline[1] as { $project: Record<string, any> }).$project;
    expect(JSON.stringify(proj.windowLandings.$let.in.$cond[2])).not.toContain("$visits");
    expect(json).not.toContain('"$sum":"$visits"');
  });

  test("the window bound is the window start's own UTC day, compared as a key", () => {
    // `landingsByDay` keys are UTC `YYYY-MM-DD`, so the bound is a string `$gte` — the same
    // comparison the download aggregates make against `downloadsByDay`.
    expect(JSON.stringify(pipeline)).toContain(`{"$gte":["$$this.k","${START.toISOString().slice(0, 10)}"]}`);
    const wide = landingsPipeline({ shareId: "one" }, windowStartUtc(90, new Date("2026-09-17T12:00:00.000Z")));
    expect(JSON.stringify(wide)).toContain('"2026-06-20"');
  });

  test("a legacy row counts as one arrival, a row that never landed counts as none", () => {
    // Half of this is the migration credit: a row written before the per-day map existed is in the
    // window and landed in it at least once. The other half is the guard that keeps the credit from
    // becoming permanent — the ingest routes upsert a `ProjectLinkView` for a recipient who deep
    // links straight to `/p/:shareId/:docId` and never opens the project page, and such a row has no
    // per-day map *and* no `visits`. Without the `$gt` every deep-link reader was a landing nobody
    // made, in every window, forever.
    const proj = (pipeline[1] as { $project: Record<string, any> }).$project;
    expect(proj.windowLandings.$let.in.$cond[0]).toEqual({
      $and: [{ $eq: [{ $size: "$$days" }, 0] }, { $gt: [{ $ifNull: ["$visits", 0] }, 0] }],
    });
    expect(proj.windowLandings.$let.in.$cond[1]).toBe(1);
  });

  test("the unbounded session array is dropped at the head, not carried through the group", () => {
    // `visitIdHashes` is hundreds of 64-char hashes per viewer and nothing here reads it.
    expect(JSON.stringify(pipeline)).not.toContain("visitIdHashes");
    expect(Object.keys(pipeline[1] as object)).toEqual(["$project"]);
  });

  test("visitors and landedWithoutOpening count rows that landed, and only those", () => {
    // Counts of *rows*, never computed after an `$unwind` of the per-day map, which would multiply
    // each row by the number of days it holds — and only the rows that landed in the window, so a
    // deep-link reader is neither a visitor nor someone who "landed without opening".
    const group = (pipeline[2] as { $group: Record<string, unknown> }).$group;
    expect(group.visitors).toEqual({ $sum: { $cond: [{ $gt: ["$windowLandings", 0] }, 1, 0] } });
    expect(group.landedWithoutOpening).toEqual({
      $sum: {
        $cond: [{ $and: [{ $gt: ["$windowLandings", 0] }, { $eq: [{ $size: "$docsOpened" }, 0] }] }, 1, 0],
      },
    });
    expect(pipeline.some((st) => "$unwind" in (st as object))).toBe(false);
  });
});

describe("readLandingRollup", () => {
  test("an empty result is zeroes, never null", () => {
    expect(readLandingRollup([])).toEqual({ landings: 0, landedWithoutOpening: 0, visitors: 0 });
    expect(readLandingRollup(undefined)).toEqual({ landings: 0, landedWithoutOpening: 0, visitors: 0 });
  });

  test("it reports the window's arrivals and the ones that opened nothing", () => {
    expect(readLandingRollup([{ landings: 9, visitors: 4, landedWithoutOpening: 2 }])).toEqual({
      landings: 9,
      landedWithoutOpening: 2,
      visitors: 4,
    });
  });

  test("landings never fall below the visitors behind them", () => {
    // Rows written before `visits` existed carry 0, but each one is still someone who arrived; a
    // tile reading "0 landings · 3 people" is a contradiction the page cannot explain.
    expect(readLandingRollup([{ landings: 0, visitors: 3, landedWithoutOpening: 3 }]).landings).toBe(3);
  });

  test("the ones who opened nothing can never exceed the ones who came", () => {
    expect(readLandingRollup([{ landings: 2, visitors: 2, landedWithoutOpening: 7 }]).landedWithoutOpening).toBe(2);
  });

  test("garbage from an aggregate is clamped rather than propagated into the tile", () => {
    const r = readLandingRollup([{ landings: -4, visitors: Number.NaN, landedWithoutOpening: 2.7 }]);
    expect(r).toEqual({ landings: 0, landedWithoutOpening: 0, visitors: 0 });
  });
});

describe("byDocPipeline", () => {
  const pipeline = byDocPipeline({ shareId: "one-link", ...RECIPIENT_ONLY_MATCH }, START, 5);

  test("it follows the caller's scope, which is how ?shareId= narrows the card", () => {
    const match = (pipeline[0] as { $match: Record<string, unknown> }).$match;
    expect(match.shareId).toBe("one-link");
    expect(match.isOwnerPreview).toEqual({ $ne: true });
  });

  test("it groups by (document, viewer) first, so `viewers` counts people and not rows", () => {
    const group = (pipeline[1] as { $group: { _id: Record<string, unknown> } }).$group;
    expect(group._id.docId).toBe("$docId");
    // The composite-splitting key, not the raw botIdHash — the whole point of the project variant.
    expect(group._id.viewer).toEqual(PROJECT_LINK_VIEWER_KEY_EXPR);
  });

  test("it ranks and bounds in Mongo, so a 400-document data room still returns a handful", () => {
    expect(pipeline.at(-2)).toEqual({ $sort: { viewers: -1, lastViewedAt: -1 } });
    expect(pipeline.at(-1)).toEqual({ $limit: 5 });
  });

  test("a nonsense limit cannot become an unbounded read", () => {
    expect(byDocPipeline({}, START, 0).at(-1)).toEqual({ $limit: 1 });
    expect(byDocPipeline({}, START, -20).at(-1)).toEqual({ $limit: 1 });
  });
});

describe("shapeByDoc", () => {
  const titles = new Map<string, string>([
    ["d1", "Term sheet"],
    ["d2", "Cap table"],
  ]);

  test("it joins titles and serialises dates for the wire", () => {
    const rows = shapeByDoc(
      [{ docId: "d1", viewers: 2, lastViewedAt: new Date("2026-09-16T10:00:00.000Z") }],
      titles,
    );
    expect(rows).toEqual([{ docId: "d1", title: "Term sheet", viewers: 2, lastViewedAt: "2026-09-16T10:00:00.000Z" }]);
  });

  test("a document deleted after the fact keeps its row, with a null title", () => {
    // Dropping it would make the card's numbers stop adding up against the totals above with
    // nothing on the page to explain the gap — the same rule the LINKS card applies to a deleted link.
    const rows = shapeByDoc([{ docId: "gone", viewers: 3, lastViewedAt: null }], titles);
    expect(rows).toEqual([{ docId: "gone", title: null, viewers: 3, lastViewedAt: null }]);
  });

  test("it sorts by viewers, then by recency", () => {
    const rows = shapeByDoc(
      [
        { docId: "d1", viewers: 1, lastViewedAt: "2026-09-10T00:00:00.000Z" },
        { docId: "d2", viewers: 4, lastViewedAt: "2026-09-01T00:00:00.000Z" },
        { docId: "d3", viewers: 4, lastViewedAt: "2026-09-16T00:00:00.000Z" },
      ],
      titles,
    );
    expect(rows.map((r) => r.docId)).toEqual(["d3", "d2", "d1"]);
  });

  test("an ObjectId-ish docId survives as a string, and a missing one is dropped", () => {
    const oid = { toString: () => "6aac2f78fcd98bf3ed0442b5" };
    const rows = shapeByDoc([{ docId: oid, viewers: 1 }, { docId: null, viewers: 9 }], titles);
    expect(rows.map((r) => r.docId)).toEqual(["6aac2f78fcd98bf3ed0442b5"]);
  });

  test("empty and malformed inputs produce an empty list, not a throw", () => {
    expect(shapeByDoc(null, titles)).toEqual([]);
    expect(shapeByDoc(undefined, titles)).toEqual([]);
  });
});

/**
 * The invariant the metrics page asserts by its own layout: the per-link column sits directly under
 * the totals tile, so a reader adds it up. If `sum(byLink[].viewers) !== totals.views` the page is
 * visibly wrong, and no error is raised anywhere.
 *
 * Both sides are counts of **(link, viewer) buckets**, which is why they agree even though a
 * project row is a (link, viewer, document) triple. These tests run the bucketing in plain JS over
 * rows shaped exactly like the stored ones — including the composite `botIdHash` — so the
 * arithmetic the pipelines are supposed to perform is pinned independently of Mongo.
 */
describe("project totals reconcile with the per-link and per-document breakdowns", () => {
  type Row = { shareId: string; docId: string; botIdHash: string; viewerUserId?: string | null };
  const sha = (s: string) => s.padEnd(64, "0").slice(0, 64);

  /** One investor (`alice`) read two documents through `L1`; two others read one each. */
  const rows: Row[] = [
    { shareId: "L1", docId: "termsheet", botIdHash: `${sha("alice")}.termsheet` },
    { shareId: "L1", docId: "captable", botIdHash: `${sha("alice")}.captable` },
    { shareId: "L1", docId: "termsheet", botIdHash: `${sha("bob")}.termsheet` },
    { shareId: "L2", docId: "termsheet", botIdHash: `${sha("carol")}.termsheet` },
    // The same person, signed in, reading through a second link: two link-recipients by design.
    { shareId: "L1", docId: "deck", botIdHash: `${sha("dave")}.deck`, viewerUserId: "u9" },
    { shareId: "L2", docId: "deck", botIdHash: `${sha("dave")}.deck`, viewerUserId: "u9" },
  ];

  /** `PROJECT_LINK_VIEWER_KEY_EXPR` in JS: the digest prefix, or the signed-in user. */
  const viewerKey = (r: Row) => `${r.shareId}|${r.viewerUserId ? `u:${r.viewerUserId}` : `a:${r.botIdHash.slice(0, 64)}`}`;
  /** `LINK_VIEWER_KEY_EXPR` in JS: the *whole* composite — the expression that must not be reused. */
  const docSideKey = (r: Row) => `${r.shareId}|${r.viewerUserId ? `u:${r.viewerUserId}` : `a:${r.botIdHash}`}`;

  const views = new Set(rows.map(viewerKey)).size;
  const byLink = [...new Set(rows.map((r) => r.shareId))].map((shareId) => ({
    shareId,
    viewers: new Set(rows.filter((r) => r.shareId === shareId).map(viewerKey)).size,
  }));

  test("views equal the distinct (link, viewer) pairs, not the stored rows", () => {
    expect(rows.length).toBe(6);
    // alice + bob on L1, carol on L2, and dave counted once per link — five link-recipients from
    // six stored rows, because alice's two documents are one person and dave's two links are two.
    expect(views).toBe(5);
  });

  test("sum(byLink.viewers) === totals.views", () => {
    expect(byLink.reduce((acc, r) => acc + r.viewers, 0)).toBe(views);
  });

  test("the document-side key would inflate the same rows — the regression this all exists to stop", () => {
    expect(new Set(rows.map(docSideKey)).size).toBe(6);
    expect(new Set(rows.map(docSideKey)).size).toBeGreaterThan(views);
  });

  test("byDoc counts (document, link, viewer) buckets, so a per-file column can exceed views", () => {
    // Deliberate and correct: alice appears under both files she opened. The card ranks documents,
    // it does not partition the recipients, and its rows are not expected to sum to the tile.
    const byDoc = shapeByDoc(
      [...new Set(rows.map((r) => r.docId))].map((docId) => ({
        docId,
        viewers: new Set(rows.filter((r) => r.docId === docId).map(viewerKey)).size,
      })),
      new Map([["termsheet", "Term sheet"], ["captable", "Cap table"], ["deck", "Deck"]]),
    );
    expect(byDoc.map((r) => [r.title, r.viewers])).toEqual([
      ["Term sheet", 3],
      ["Deck", 2],
      ["Cap table", 1],
    ]);
    expect(byDoc.reduce((acc, r) => acc + r.viewers, 0)).toBeGreaterThan(views);
  });

  test("totals.docsOpened is the union of the documents, matching the DOCUMENTS card's rows", () => {
    const docsOpened = new Set(rows.map((r) => r.docId)).size;
    const byDocRows = shapeByDoc(
      [...new Set(rows.map((r) => r.docId))].map((docId) => ({ docId, viewers: 1 })),
      new Map(),
    );
    expect(docsOpened).toBe(3);
    expect(byDocRows.length).toBe(docsOpened);
  });
});

describe("viewsByDayPipeline", () => {
  const SCOPE = { shareId: { $in: ["jPaOy2VcGD5R"] }, ...RECIPIENT_ONLY_MATCH };

  /**
   * The bug, stated as an ordering rule. On a project link one (link, viewer) owns one row per
   * document opened, so a `$group` on `{ day, viewer }` buckets that viewer once per document and
   * the chart sums to more than the VIEWS tile above it. The viewer bucket has to close first.
   *
   * Failure scenario it pins: a recipient opens the deck on Monday and the term sheet on Wednesday
   * through one link. Two rows, two `lastViewedAt`s, two day-buckets — chart 2, tile 1. The seed
   * data hid it because one viewer read both files inside the same UTC day, so a live check passed.
   */
  test("the viewer bucket closes before the day bucket opens", () => {
    const [, viewerGroup, dayGroup] = viewsByDayPipeline(SCOPE, START) as Array<Record<string, any>>;
    expect(viewerGroup.$group._id).toEqual(PROJECT_LINK_VIEWER_KEY_EXPR);
    // No day anywhere in the first bucket: that is the whole fix.
    expect(JSON.stringify(viewerGroup.$group._id)).not.toContain("dateToString");
    expect(dayGroup.$group._id).toEqual({
      $dateToString: { date: "$lastSeen", format: "%Y-%m-%d", timezone: "UTC" },
    });
  });

  test("the day bucket counts viewers, so the area under the chart is `totals.views`", () => {
    const [, , dayGroup] = viewsByDayPipeline(SCOPE, START) as Array<Record<string, any>>;
    // One per closed viewer bucket — the same quantity `totalsForMatch` counts.
    expect(dayGroup.$group.views).toEqual({ $sum: 1 });
  });

  test("it groups the viewer bucket on last activity, never on `updatedDate` alone", () => {
    const [, viewerGroup] = viewsByDayPipeline(SCOPE, START) as Array<Record<string, any>>;
    expect(viewerGroup.$group.lastSeen).toEqual({ $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } });
  });

  test("it carries the caller's scope and the window, and sorts by day", () => {
    const stages = viewsByDayPipeline(SCOPE, START) as Array<Record<string, any>>;
    expect(stages[0].$match.shareId).toEqual({ $in: ["jPaOy2VcGD5R"] });
    expect(stages[0].$match.isOwnerPreview).toEqual(RECIPIENT_ONLY_MATCH.isOwnerPreview);
    expect(stages[0].$match.$or).toBeTruthy();
    expect(stages[stages.length - 1]).toEqual({ $sort: { _id: 1 } });
  });

  test("every field it reads exists on `ShareView`", () => {
    const refs = fieldRefs(viewsByDayPipeline(SCOPE, START));
    // `$lastSeen` is this pipeline's own intermediate, not a stored field.
    for (const ref of refs) {
      expect(["$shareId", "$viewerUserId", "$botIdHash", "$lastViewedAt", "$updatedDate", "$lastSeen"]).toContain(ref);
    }
  });
});
