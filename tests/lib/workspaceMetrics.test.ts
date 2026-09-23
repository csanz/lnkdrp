/**
 * Workspace metrics helpers (docs/prds/lnkdrp-workspace-metrics.md, M1): range resolution and the
 * Free clamp, previous-period windows, deltas, the zero-filled day series, ranking and the quiet
 * document selection — plus the shape of the Mongo fragments, which fail silently when wrong.
 *
 * Expectations are derived from the rules, not copied from live rows.
 */
import { describe, expect, test } from "vitest";

import { FREE_ANALYTICS_DAYS } from "@/lib/billing/planLimits";
import {
  activityBetweenMatch,
  linkReaderKeyExpr,
  liveShareLinkExpr,
  presenceBetweenMatch,
  VISIT_DAY_KEY_EXPR,
  VISIT_TIME_SUM_EXPR,
  visitBetweenMatch,
  visitWindowMatch,
  workspaceOrgMatch,
  WORKSPACE_NAMED_ROW_MATCH,
  WORKSPACE_PERSON_KEY_EXPR,
  WORKSPACE_VIEWER_KEY_EXPR,
} from "@/lib/analytics/workspace/match";
import { PROJECT_VIEW_KEY_SEP } from "@/lib/share/projectPublic";
import {
  avgReadingTimeMs,
  buildSeries,
  buildTopLink,
  buildTopLinks,
  changePct,
  delta,
  dayKeysFrom,
  docMetricsHref,
  linkMetricsHref,
  parseWorkspaceRangeKey,
  projectLinkMetricsHref,
  rankPeople,
  rankTopDocs,
  rankTopLinks,
  resolveWorkspaceRange,
  QUIET_DOC_GRACE_MS,
  selectQuietDocs,
  WORKSPACE_DEFAULT_RANGE,
  workspacePlanInfo,
  type WorkspaceLinkCandidate,
  type WorkspaceLinkIdentity,
  type WorkspacePerson,
  type WorkspaceTopDoc,
} from "@/lib/analytics/workspace";

/** A fixed "now" inside a day, so the window's UTC-midnight snapping is visible. */
const NOW = new Date("2026-09-17T13:45:00.000Z");

describe("range parsing", () => {
  test("accepts the three keys and defaults to 30 days", () => {
    expect(parseWorkspaceRangeKey("7d")).toBe("7d");
    expect(parseWorkspaceRangeKey("30d")).toBe("30d");
    expect(parseWorkspaceRangeKey("90D")).toBe("90d");
    expect(parseWorkspaceRangeKey(null)).toBe(WORKSPACE_DEFAULT_RANGE);
    expect(parseWorkspaceRangeKey("14d")).toBe("30d");
    expect(parseWorkspaceRangeKey("")).toBe("30d");
  });
});

describe("resolveWorkspaceRange", () => {
  test("Pro 30d: the window starts 29 UTC days back and ends today", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "pro", now: NOW });
    expect(r.range.days).toBe(30);
    expect(r.range.key).toBe("30d");
    expect(r.range.clampedByPlan).toBe(false);
    expect(r.range.start).toBe("2026-08-19");
    expect(r.range.end).toBe("2026-09-17");
    expect(r.dayKeys).toHaveLength(30);
    expect(r.start.toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  test("Pro: the previous period is the same length, ending where the current one starts", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "pro", now: NOW });
    expect(r.previousStart?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(r.previousEnd?.toISOString()).toBe(r.start.toISOString());
    expect(r.range.previous).toEqual({ start: "2026-07-20", end: "2026-08-18" });
  });

  test("Free: 30d is clamped to the plan window and says so, and carries no previous period", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "free", now: NOW });
    expect(r.range.days).toBe(FREE_ANALYTICS_DAYS);
    expect(r.range.key).toBe("7d");
    expect(r.range.requested).toBe("30d");
    expect(r.range.clampedByPlan).toBe(true);
    expect(r.range.start).toBe("2026-09-11");
    expect(r.range.previous).toBeNull();
    expect(r.previousStart).toBeNull();
  });

  test("Free: 7d is served whole and is not reported as clamped", () => {
    const r = resolveWorkspaceRange({ requested: "7d", plan: "free", now: NOW });
    expect(r.range.days).toBe(7);
    expect(r.range.clampedByPlan).toBe(false);
  });

  test("plan info is what the UI locks its range control with", () => {
    expect(workspacePlanInfo("pro")).toEqual({ isPro: true, analyticsDays: null });
    expect(workspacePlanInfo("free")).toEqual({ isPro: false, analyticsDays: FREE_ANALYTICS_DAYS });
  });

  test("day keys run forwards and cross a month boundary", () => {
    expect(dayKeysFrom(new Date("2026-08-30T00:00:00.000Z"), 3)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(dayKeysFrom(new Date("2026-08-30T00:00:00.000Z"), 0)).toEqual([]);
  });
});

describe("deltas", () => {
  test("percent change, rounded to one decimal", () => {
    expect(changePct(118, 100)).toBe(18);
    expect(changePct(50, 100)).toBe(-50);
    expect(changePct(231, 115)).toBe(100.9);
  });

  test("no percentage where one would be a lie", () => {
    expect(changePct(10, 0)).toBeNull(); // the seed corpus's 30d comparison window is empty
    expect(changePct(10, null)).toBeNull(); // Free: no previous period served
    expect(changePct(0, 0)).toBeNull();
  });

  test("delta clamps junk to a count and keeps a withheld previous null", () => {
    expect(delta(12.7, 10)).toEqual({ value: 12, previous: 10, changePct: 20 });
    expect(delta(5, null)).toEqual({ value: 5, previous: null, changePct: null });
    expect(delta(Number.NaN, 0)).toEqual({ value: 0, previous: 0, changePct: null });
  });
});

describe("series", () => {
  test("every day is present and missing days are zeros, not gaps", () => {
    const days = ["2026-09-15", "2026-09-16", "2026-09-17"];
    const series = buildSeries(days, {
      views: new Map([["2026-09-15", 4], ["2026-09-17", 2]]),
      opens: new Map([["2026-09-15", 3]]),
      readingTimeMs: new Map([["2026-09-17", 90_000]]),
      downloads: new Map([["2026-09-16", 1]]),
    });
    expect(series.map((p) => p.day)).toEqual(days);
    expect(series.map((p) => p.views)).toEqual([4, 0, 2]);
    expect(series.map((p) => p.opens)).toEqual([3, 0, 0]);
    expect(series.map((p) => p.readingTimeMs)).toEqual([0, 0, 90_000]);
    expect(series.map((p) => p.downloads)).toEqual([0, 1, 0]);
  });

  test("the area under a series equals its headline figure", () => {
    const days = dayKeysFrom(new Date("2026-09-11T00:00:00.000Z"), 7);
    const views = new Map([["2026-09-11", 10], ["2026-09-13", 21], ["2026-09-17", 5]]);
    const series = buildSeries(days, { views, opens: new Map(), readingTimeMs: new Map(), downloads: new Map() });
    expect(series.reduce((a, p) => a + p.views, 0)).toBe(36);
  });
});

describe("averages and hrefs", () => {
  test("average reading time is per viewer, and zero viewers is not a division", () => {
    expect(avgReadingTimeMs(90_000, 4)).toBe(22_500);
    expect(avgReadingTimeMs(1, 3)).toBe(0);
    expect(avgReadingTimeMs(90_000, 0)).toBe(0);
  });

  test("rows lead to the document metrics page, links to it filtered", () => {
    expect(docMetricsHref("6aabaeda4b86405f0713e6b7")).toBe("/doc/6aabaeda4b86405f0713e6b7/metrics");
    expect(linkMetricsHref("6aabaeda4b86405f0713e6b7", "a b/c")).toBe(
      "/doc/6aabaeda4b86405f0713e6b7/metrics?shareId=a%20b%2Fc",
    );
  });

  test("a project link leads to the project's metrics page, not a document's", () => {
    expect(projectLinkMetricsHref("6aac2ad2484f54dffdb9e0be", "a b/c")).toBe(
      "/project/6aac2ad2484f54dffdb9e0be/metrics?shareId=a%20b%2Fc",
    );
  });
});

/**
 * Labelling a ranked link row.
 *
 * The bug this pins: a project link is one `shareId` over several documents, and naming it after
 * one of them sent the row to `/doc/:docId/metrics?shareId=`, which 404s for a link the document
 * does not own — while the duplicate rows it produced collided on their React key.
 */
describe("top link rows", () => {
  const titles: Record<string, string> = { doc1: "Series A deck", doc2: "Cap table" };
  const docTitle = (docId: string) => titles[docId] ?? "Untitled";

  const candidate = (over: Partial<WorkspaceLinkCandidate> = {}): WorkspaceLinkCandidate => ({
    shareId: "sh1",
    docIds: ["doc1"],
    rows: 7,
    readers: 7,
    lastOpenedAt: "2026-09-17T19:31:50.558Z",
    ...over,
  });

  test("a document link keeps its document, its title and its document metrics href", () => {
    const row = buildTopLink(
      candidate(),
      { shareLinkId: "lnk1", kind: "doc", label: "Sequoia", audience: "Roelof", isDefault: false, docId: "doc1" },
      docTitle,
    );
    expect(row).toMatchObject({
      shareId: "sh1",
      shareLinkId: "lnk1",
      kind: "doc",
      label: "Sequoia",
      audience: "Roelof",
      docId: "doc1",
      projectId: null,
      parentName: "Series A deck",
      views: 7,
      viewers: 7,
      href: "/doc/doc1/metrics?shareId=sh1",
    });
  });

  test("an unlabelled document link still reads as its document, as it always did", () => {
    const row = buildTopLink(candidate(), { kind: "doc", label: "   ", isDefault: true, docId: "doc1" }, docTitle);
    expect(row.label).toBe("Series A deck");
    expect(row.isDefault).toBe(true);
    expect(row.shareLinkId).toBeNull();
    expect(row.audience).toBeNull();
  });

  test("a project link is one row: its own label, the project underneath, the project's metrics page", () => {
    const row = buildTopLink(
      candidate({ docIds: ["doc1", "doc2"], rows: 9, readers: 5 }),
      { shareLinkId: "lnk2", kind: "project", label: "Sequoia · diligence", projectId: "prj1", projectName: "Data room" },
      docTitle,
    );
    expect(row).toMatchObject({
      kind: "project",
      label: "Sequoia · diligence",
      docId: null,
      projectId: "prj1",
      parentName: "Data room",
      // Recipients, never the 9 (viewer x document) rows: the locked rule, and the only figure the
      // project metrics page this row opens will agree with.
      views: 5,
      viewers: 5,
      href: "/project/prj1/metrics?shareId=sh1",
    });
    // Never a document: the row spans two, and the document page refuses this shareId.
    expect(row.href).not.toContain("/doc/");
  });

  test("an unlabelled project link falls back to the project, and a deleted project to a generic name", () => {
    const named = buildTopLink(
      candidate({ docIds: ["doc1", "doc2"] }),
      { kind: "project", label: "", projectId: "prj1", projectName: "Data room" },
      docTitle,
    );
    expect(named.label).toBe("Data room");

    const orphan = buildTopLink(
      candidate({ docIds: ["doc1", "doc2"] }),
      { kind: "project", label: "", projectId: "prj1", projectName: null },
      docTitle,
    );
    expect(orphan.parentName).toBe("Project");
    expect(orphan.label).toBe("Project");
    expect(orphan.href).toBe("/project/prj1/metrics?shareId=sh1");
  });

  test("a hard-deleted link is still exactly one row, named by the document its views landed on", () => {
    const row = buildTopLink(candidate({ docIds: ["doc1", "doc2"] }), null, docTitle);
    expect(row.kind).toBe("doc");
    expect(row.shareLinkId).toBeNull();
    expect(row.label).toBe("Series A deck");
    expect(row.docId).toBe("doc1");
    expect(row.href).toBe("/doc/doc1/metrics?shareId=sh1");
  });

  test("a project link with no project to point at degrades to its document rather than a broken href", () => {
    const row = buildTopLink(candidate(), { kind: "project", label: "Orphan", projectId: null }, docTitle);
    expect(row.kind).toBe("doc");
    expect(row.href).toBe("/doc/doc1/metrics?shareId=sh1");
  });

  test("a mixed list has one row per shareId, in rank order, and no duplicate keys", () => {
    const identities: Record<string, WorkspaceLinkIdentity> = {
      project: { kind: "project", label: "Sequoia · diligence", projectId: "prj1", projectName: "Data room" },
      docLink: { kind: "doc", label: "Accel", docId: "doc2" },
    };
    const rows = buildTopLinks(
      [
        candidate({ shareId: "docLink", docIds: ["doc2"], rows: 4, readers: 4 }),
        // 9 rows but only 3 recipients: the raw row count would put this first, the figure the card
        // actually prints puts it second. Ranking has to follow what the reader sees.
        candidate({ shareId: "project", docIds: ["doc1", "doc2"], rows: 9, readers: 3 }),
      ],
      (shareId) => identities[shareId],
      docTitle,
      8,
    );
    expect(rows.map((r) => r.shareId)).toEqual(["docLink", "project"]);
    expect(rows.map((r) => r.kind)).toEqual(["doc", "project"]);
    expect(rows.map((r) => r.views)).toEqual([4, 3]);
    expect(new Set(rows.map((r) => r.shareId)).size).toBe(rows.length);
  });

  test("the list is bounded", () => {
    const rows = buildTopLinks(
      ["a", "b", "c"].map((shareId, i) => candidate({ shareId, rows: 10 - i, readers: 10 - i })),
      () => ({ kind: "doc", docId: "doc1" }),
      docTitle,
      2,
    );
    expect(rows.map((r) => r.shareId)).toEqual(["a", "b"]);
  });
});

/** A top-document row with only the fields ranking looks at. */
function doc(docId: string, views: number, viewers: number, lastOpenedAt: string | null): WorkspaceTopDoc {
  return {
    docId,
    title: docId,
    views,
    viewers,
    opens: 0,
    readingTimeMs: 0,
    avgReadingTimeMs: 0,
    lastOpenedAt,
    href: docMetricsHref(docId),
  };
}

describe("ranking", () => {
  test("documents rank by views, then viewers, then recency, then id", () => {
    const ranked = rankTopDocs(
      [
        doc("b", 10, 4, "2026-09-10T00:00:00.000Z"),
        doc("a", 10, 4, "2026-09-10T00:00:00.000Z"),
        doc("c", 10, 9, "2026-09-01T00:00:00.000Z"),
        doc("d", 40, 1, null),
        doc("e", 10, 4, "2026-09-16T00:00:00.000Z"),
      ],
      3,
    );
    expect(ranked.map((r) => r.docId)).toEqual(["d", "c", "e"]);
  });

  test("links rank the same way and the list is bounded", () => {
    const link = (shareId: string, views: number): WorkspaceLinkCandidate => ({
      shareId,
      docIds: ["doc1"],
      rows: views,
      readers: views,
      lastOpenedAt: null,
    });
    const ranked = rankTopLinks(
      [link("x", 1), link("y", 9), link("z", 5)].map((c) => buildTopLink(c, { docId: "doc1" }, () => "Doc")),
      2,
    );
    expect(ranked.map((r) => r.shareId)).toEqual(["y", "z"]);
  });

  test("people rank by reading time, because the question is who is reading", () => {
    const person = (key: string, ms: number, docs: number): WorkspacePerson => ({
      key,
      name: key,
      email: `${key}@example.com`,
      readingTimeMs: ms,
      docs,
      lastSeenAt: null,
      // Ranking is by reading time; none of what a row *displays* is part of that question.
      depthSample: null,
      docTitle: null,
      readerHref: null,
    });
    const ranked = rankPeople([person("a", 10, 50), person("b", 900, 1), person("c", 900, 4)], 2);
    expect(ranked.map((r) => r.key)).toEqual(["c", "b"]);
  });
});

describe("gone quiet", () => {
  test("shared documents with no opens, newest share first, bounded", () => {
    const shared = [
      { docId: "old", title: "Old", sharedAt: "2026-01-01T00:00:00.000Z" },
      { docId: "new", title: "New", sharedAt: "2026-09-16T00:00:00.000Z" },
      { docId: "read", title: "Read", sharedAt: "2026-09-15T00:00:00.000Z" },
      { docId: "mid", title: "Mid", sharedAt: "2026-05-05T00:00:00.000Z" },
    ];
    const quiet = selectQuietDocs(shared, new Set(["read"]), 2, NOW.getTime());
    expect(quiet.map((q) => q.docId)).toEqual(["new", "mid"]);
    expect(quiet[0].href).toBe("/doc/new/metrics");
  });

  test("a document shared in the last day has not gone quiet yet", () => {
    // The section header used to read "no opens in 90 days" over eight rows saying "shared 2 hours
    // ago"; the freshest documents crowded out every genuinely stale one.
    const justNow = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(NOW.getTime() - QUIET_DOC_GRACE_MS - 1000).toISOString();
    const quiet = selectQuietDocs(
      [
        { docId: "fresh", title: "Fresh", sharedAt: justNow },
        { docId: "stale", title: "Stale", sharedAt: yesterday },
      ],
      new Set(),
      5,
      NOW.getTime(),
    );
    expect(quiet.map((q) => q.docId)).toEqual(["stale"]);
  });

  test("a document with no live link is absent rather than dated by something else", () => {
    // `sharedAt: null` means no enabled, unexpired link — nobody can open it, so nudging a
    // recipient about it is advice that cannot work.
    const quiet = selectQuietDocs(
      [
        { docId: "undated", title: "Undated", sharedAt: null },
        { docId: "dated", title: "Dated", sharedAt: "2026-02-02T00:00:00.000Z" },
      ],
      new Set(),
      5,
      NOW.getTime(),
    );
    expect(quiet.map((q) => q.docId)).toEqual(["dated"]);
  });
});

describe("mongo fragments", () => {
  test("the previous-period window is half-open and keeps the legacy fallback branch", () => {
    const start = new Date("2026-07-20T00:00:00.000Z");
    const end = new Date("2026-08-19T00:00:00.000Z");
    expect(activityBetweenMatch(start, end)).toEqual({
      $or: [
        { lastViewedAt: { $gte: start, $lt: end } },
        { lastViewedAt: null, updatedDate: { $gte: start, $lt: end } },
      ],
    });
  });

  test("the previous period also catches a row first seen in it, so a returning reader stays in the baseline", () => {
    const start = new Date("2026-07-20T00:00:00.000Z");
    const end = new Date("2026-08-19T00:00:00.000Z");
    const clauses = presenceBetweenMatch(start, end).$or as Array<Record<string, unknown>>;
    expect(clauses).toHaveLength(3);
    expect(clauses[2]).toEqual({ createdDate: { $gte: start, $lt: end } });
  });

  test("visits are bounded by lastEventAt, bucketed by it, and summed from timeSpentMs", () => {
    const start = new Date("2026-08-19T00:00:00.000Z");
    const end = new Date("2026-09-18T00:00:00.000Z");
    expect(visitWindowMatch(start)).toEqual({ lastEventAt: { $gte: start } });
    expect(visitBetweenMatch(start, end)).toEqual({ lastEventAt: { $gte: start, $lt: end } });
    // A wrong field reference in an aggregation expression yields null, not an error.
    expect(JSON.stringify(VISIT_DAY_KEY_EXPR)).toContain("$lastEventAt");
    expect(JSON.stringify(VISIT_DAY_KEY_EXPR)).toContain("%Y-%m-%d");
    expect(VISIT_TIME_SUM_EXPR).toEqual({ $sum: { $ifNull: ["$timeSpentMs", 0] } });
  });

  test("the workspace scope tolerates a denormalized orgId that has not been backfilled", () => {
    // Tenancy comes from `docId: { $in: <live docs> }`; a plain `{ orgId }` equality silently
    // dropped every row written before the field existed.
    expect(workspaceOrgMatch("org1")).toEqual({ orgId: { $in: ["org1", null] } });
  });

  test("a live link is enabled, unarchived and unexpired", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const expr = liveShareLinkExpr(now).$and as Array<Record<string, unknown>>;
    expect(expr).toHaveLength(3);
    expect(JSON.stringify(expr)).toContain("$enabled");
    expect(JSON.stringify(expr)).toContain("$archivedAt");
    expect(JSON.stringify(expr)).toContain("$expiresAt");
  });

  test("the bucket is (document, link, viewer) — the document page's key plus the document", () => {
    expect(Object.keys(WORKSPACE_VIEWER_KEY_EXPR)).toEqual(["docId", "shareId", "viewer"]);
    expect(WORKSPACE_VIEWER_KEY_EXPR.docId).toBe("$docId");
    expect(WORKSPACE_VIEWER_KEY_EXPR.shareId).toBe("$shareId");
  });

  test("the per-link reader key strips the document a project link spells into the viewer", () => {
    const expr = linkReaderKeyExpr("$_id.viewer") as unknown as {
      $arrayElemAt: [{ $split: [string, string] }, number];
    };
    // Element 0 of a split on the separator `projectViewerKey` joins with: everything before the
    // document id, which is the person. Anything else counts a data-room reader once per document.
    expect(expr.$arrayElemAt[1]).toBe(0);
    expect(expr.$arrayElemAt[0].$split[0]).toBe("$_id.viewer");
    expect(expr.$arrayElemAt[0].$split[1]).toBe(PROJECT_VIEW_KEY_SEP);

    // The reference implementation of what Mongo then does, on both kinds of key.
    const strip = (key: string) => key.split(PROJECT_VIEW_KEY_SEP)[0];
    const reader = "a:".concat("f".repeat(64));
    expect(strip(`${reader}${PROJECT_VIEW_KEY_SEP}6aac2f78fcd98bf3ed0442b5`)).toBe(reader);
    expect(strip(`${reader}${PROJECT_VIEW_KEY_SEP}6aac2b58484f54dffdb9e1b8`)).toBe(reader);
    // A document link's key has no document in it and must come through untouched.
    expect(strip(reader)).toBe(reader);
    expect(strip("u:6aa4a3a4b0b9b3a1a769660a")).toBe("u:6aa4a3a4b0b9b3a1a769660a");
  });

  test("the person key prefers email, falls back to the user id and is otherwise null", () => {
    const expr = WORKSPACE_PERSON_KEY_EXPR as unknown as {
      $let: { vars: { email: unknown }; in: { $cond: unknown[] } };
    };
    expect(JSON.stringify(expr.$let.vars.email)).toContain("viewerEmailSnapshot");
    expect(JSON.stringify(expr.$let.vars.email)).toContain("viewerEmail");
    expect(JSON.stringify(expr.$let.in)).toContain("viewerUserId");
    // The "no identity at all" branch must stay null, so those rows can be dropped by a $match.
    expect(JSON.stringify(expr.$let.in)).toContain("null");
  });

  test("only rows carrying an identity reach the people aggregate", () => {
    expect(WORKSPACE_NAMED_ROW_MATCH).toEqual({
      $or: [{ viewerEmailSnapshot: { $ne: null } }, { viewerEmail: { $ne: null } }, { viewerUserId: { $ne: null } }],
    });
  });
});
