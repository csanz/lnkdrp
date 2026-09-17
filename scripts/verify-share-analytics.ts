/**
 * Read-only audit of the share analytics invariants.
 *
 * Every bug this checks for was found by a person reading two numbers on one screen and noticing
 * they could not both be true. That is a slow and unreliable detector, and each of these is a
 * one-line arithmetic property that a script can check over the whole database in a second.
 *
 * The invariants, and the failure each one catches:
 *
 * 1. `sum(pageTimeMsByPage) <= timeSpentMs` on every `ShareView` and `ShareVisit` row.
 *    Time on a page is time in the visit, so the parts cannot exceed the whole. This is the direct
 *    detector for the double count: the viewer runs a visit clock and a page clock over the same
 *    seconds, and when one payload field fed both counters a three-page read of 20 seconds stored
 *    34. See src/lib/analytics/shareTiming.ts.
 *
 * 2. `ShareLink.viewCount` / `downloadCount` / `lastViewedAt` equal the recomputation from rows.
 *    A counter and a row count drift. They did: `/links` reported 4 views and a later "last viewed"
 *    than the metrics page for the same link, because the owner-preview pass reclassified rows the
 *    counters had already counted.
 *
 * 3. The document's figures equal the sum over its links.
 *    The per-link table sits directly under the "All links" tiles and readers add the column up.
 *
 * 4. No owner-preview row is inside a recipient figure, and no row is flagged without a viewer.
 *    `isOwnerPreview` needs a signed-in session to be knowable; a flagged anonymous row means
 *    something set it that should not have.
 *
 * Reading analytics (`/api/docs/:docId/pages`), built in-process with the route's own loader over
 * 365 days at document scope:
 *
 * 5. Timed page segments fit inside visit time: on tv2 visits the valid page durations sum to at
 *    most `timeSpentMs` + 1s, and a person whose visits are all tv2 has page cells summing to at
 *    most their total + 1s per visit.
 * 6. Every matrix row has one cell per page, and the page table has one row per page.
 * 7. The person endpoint agrees with that person's matrix row (page ms, pages reached, exit page,
 *    total time).
 * 8. `people` equals a fresh run of the `/shareviews` viewer-count aggregate.
 * 9. The link rows' people sum to the document's people.
 * 10. `everOpened` is exactly "has an all-time last opened", and anyone in range means the in-range
 *     and all-time last opened are the same instant.
 * 11. A link listed as not opened yet has never been opened.
 * 12. A page shows a typical time exactly when at least 3 people stayed on it.
 * 13. Total time covers the matrix rows, equals a fresh `/shareviews` `totals.visitTimeMs` when no
 *     visit is unmatched or truncated, and the callout gate text and callouts follow the people counts.
 *
 * Reads only. Safe to run against production and against a database another session is writing to.
 *
 * Usage:
 *   npm run verify:analytics                  # every document that has links
 *   npm run verify:analytics -- --doc <docId> # one document
 *   npm run verify:analytics -- --quiet       # only failures
 *
 * Exit code is 1 when any invariant fails, so it works as a CI step or a pre-deploy gate.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { loadReadingCore } from "@/lib/analytics/loadReading";
import { RECIPIENT_ONLY_MATCH, activityWindowMatch, windowStartUtc } from "@/lib/analytics/shareViewAggregates";
import {
  MATRIX_ALL_LIMIT,
  buildPersonResponse,
  buildReadingResponse,
  calloutGateText,
  toMs,
  type DocPagesInput,
} from "@/lib/analytics/reading";

type Failure = { invariant: string; scope: string; detail: string };

/**
 * How far a link's stored `lastViewedAt` may sit from the rows before it counts as drift.
 *
 * The two timestamps are written by two statements a few milliseconds apart, so they are never
 * bit-identical on a link that is being read right now. Anything past a couple of seconds means
 * they are describing different events, which is the condition worth reporting.
 */
const LAST_VIEWED_TOLERANCE_MS = 2000;

/**
 * How long after a row's last activity it counts as finished.
 *
 * The viewer's visit clock flushes every 30 seconds and at close, so a row touched more recently
 * than this may simply be mid-flush rather than wrong.
 */
const SETTLE_MS = 3 * 60 * 1000;

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Sum a `Map`-typed Mongo field that comes back as a plain object. */
function sumMap(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  let total = 0;
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/**
 * Invariant 1, over one collection. A row's per-page times must fit inside its total.
 *
 * Only settled rows. The two clocks are not in lockstep while someone is still reading: a page turn
 * reports its segment immediately, while the visit clock flushes on the 30-second heartbeat and at
 * close, so mid-visit the pages legitimately add up to more than the total and catch up when the
 * final flush lands. Checking a live visit reports a failure that fixes itself, which is worse than
 * not checking it. `SETTLE_MS` past the row's last activity is long enough that any flush that was
 * ever going to arrive has.
 *
 * `toleranceMs` covers the remainder: both numbers are best-effort wall-clock deltas reported by a
 * browser over separate beacons. A real double count is off by seconds, not milliseconds.
 */
async function checkPageTimeFitsTotal(
  // The two models have different document shapes, so a union of them has no callable `find`.
  // Only the four fields below are read, and both collections carry all four.
  model: { find: (filter: Record<string, unknown>) => { select: (p: Record<string, 1>) => { lean: () => Promise<unknown[]> } } },
  label: string,
  docId: Types.ObjectId | null,
  toleranceMs = 2000,
): Promise<Failure[]> {
  const failures: Failure[] = [];
  const settledBefore = new Date(Date.now() - SETTLE_MS);
  const rows = (await model
    .find({
      ...(docId ? { docId } : {}),
      // `ShareVisit` carries `lastEventAt`, `ShareView` carries `lastViewedAt`; a row with neither
      // predates both fields and is certainly settled.
      $or: [
        { lastEventAt: { $lt: settledBefore } },
        { lastViewedAt: { $lt: settledBefore } },
        { lastEventAt: null, lastViewedAt: null },
      ],
    })
    .select({ _id: 1, shareId: 1, timeSpentMs: 1, pageTimeMsByPage: 1 })
    .lean()) as Array<{ _id: unknown; shareId?: string; timeSpentMs?: number; pageTimeMsByPage?: unknown }>;
  for (const row of rows) {
    const total = typeof row.timeSpentMs === "number" && Number.isFinite(row.timeSpentMs) ? row.timeSpentMs : 0;
    const pages = sumMap(row.pageTimeMsByPage);
    if (pages > total + toleranceMs) {
      failures.push({
        invariant: "page time fits inside total time",
        scope: `${label} ${String(row._id)} (${row.shareId ?? "?"})`,
        detail: `pages sum to ${pages}ms but the row's total is ${total}ms — over by ${pages - total}ms`,
      });
    }
  }
  return failures;
}

/** Invariants 2 and 3, for one document. */
async function checkDocument(docId: Types.ObjectId): Promise<Failure[]> {
  const failures: Failure[] = [];
  const links = await ShareLinkModel.find({ docId })
    .select({ _id: 1, shareId: 1, label: 1, viewCount: 1, downloadCount: 1, lastViewedAt: 1 })
    .lean();

  const perLink = (await ShareViewModel.aggregate([
    { $match: { docId, isOwnerPreview: { $ne: true } } },
    {
      $group: {
        _id: "$shareId",
        viewCount: { $sum: 1 },
        downloadCount: { $sum: { $ifNull: ["$downloads", 0] } },
        lastViewedAt: { $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } },
      },
    },
  ])) as Array<{ _id: string; viewCount: number; downloadCount: number; lastViewedAt?: Date | null }>;
  const bySlug = new Map(perLink.map((r) => [r._id, r]));

  for (const link of links) {
    const slug = String((link as { shareId?: unknown }).shareId ?? "");
    const truth = bySlug.get(slug) ?? { viewCount: 0, downloadCount: 0, lastViewedAt: null };
    const stored = link as { viewCount?: number; downloadCount?: number; lastViewedAt?: Date | null; label?: string };
    const scope = `link ${slug} (${stored.label ?? "?"})`;
    if ((stored.viewCount ?? 0) !== truth.viewCount) {
      failures.push({
        invariant: "link counters match the rows",
        scope,
        detail: `ShareLink.viewCount is ${stored.viewCount ?? 0} but ${truth.viewCount} recipient rows exist`,
      });
    }
    if ((stored.downloadCount ?? 0) !== truth.downloadCount) {
      failures.push({
        invariant: "link counters match the rows",
        scope,
        detail: `ShareLink.downloadCount is ${stored.downloadCount ?? 0} but the rows sum to ${truth.downloadCount}`,
      });
    }
    // Milliseconds apart is not drift. `touchShareLink` stamps the link with its own `new Date()`
    // while the ingest stamps the row with another a few milliseconds earlier, so exact equality
    // reports a failure on every healthy link that has just been viewed — and a check that cries
    // wolf on healthy data is a check people learn to ignore.
    const storedLast = stored.lastViewedAt ? new Date(stored.lastViewedAt).getTime() : null;
    const truthLast = truth.lastViewedAt ? new Date(truth.lastViewedAt).getTime() : null;
    const lastDrifted =
      storedLast === null || truthLast === null ? storedLast !== truthLast : Math.abs(storedLast - truthLast) > LAST_VIEWED_TOLERANCE_MS;
    if (lastDrifted) {
      failures.push({
        invariant: "link counters match the rows",
        scope,
        detail: `ShareLink.lastViewedAt is ${stored.lastViewedAt ? new Date(stored.lastViewedAt).toISOString() : "null"} but the rows say ${
          truth.lastViewedAt ? new Date(truth.lastViewedAt).toISOString() : "null"
        }`,
      });
    }
  }

  // Invariant 3: the document total is the sum over its links, archived slugs included.
  const docTotal = await ShareViewModel.countDocuments({ docId, isOwnerPreview: { $ne: true } });
  const linkSum = perLink.reduce((a, r) => a + r.viewCount, 0);
  if (docTotal !== linkSum) {
    failures.push({
      invariant: "the document equals the sum of its links",
      scope: `doc ${String(docId)}`,
      detail: `document counts ${docTotal} recipient rows but its links sum to ${linkSum}`,
    });
  }
  return failures;
}

/** Invariant 4, over the whole database (or one document). */
async function checkOwnerPreviewSanity(docId: Types.ObjectId | null): Promise<Failure[]> {
  const scope = docId ? { docId } : {};
  const flaggedAnonymous = await ShareViewModel.countDocuments({
    ...scope,
    isOwnerPreview: true,
    $or: [{ viewerUserId: null }, { viewerUserId: { $exists: false } }],
  });
  if (flaggedAnonymous > 0) {
    return [
      {
        invariant: "only signed-in rows are owner previews",
        scope: docId ? `doc ${String(docId)}` : "database",
        detail: `${flaggedAnonymous} row(s) are flagged isOwnerPreview with no viewerUserId — the flag needs a session to be knowable`,
      },
    ];
  }
  return [];
}

/** The reading invariants run over the longest range the metrics page offers. */
const READING_DAYS = 365;

/** Slack per visit for invariant 5: two clocks over the same seconds, flooring each POST. */
const VISIT_TOLERANCE_MS = 1000;

/** Invariant names whose inputs are two separate reads, which traffic landing in between can split. */
const READ_RACE_INVARIANTS = new Set(["people equals the shareviews viewer count", "total time equals shareviews visitTimeMs"]);

/** `/shareviews` `viewerCount`, recomputed with the route's own `windowAgg` grouping. */
async function freshViewerCount(docId: Types.ObjectId, start: Date): Promise<number> {
  const rows = (await ShareViewModel.aggregate([
    { $match: { docId, ...RECIPIENT_ONLY_MATCH, ...activityWindowMatch(start) } },
    {
      $group: {
        _id: {
          shareId: "$shareId",
          viewer: {
            $cond: [
              { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
              { kind: "user", key: { $toString: "$viewerUserId" } },
              { kind: "anon", key: { $ifNull: ["$botIdHash", ""] } },
            ],
          },
        },
      },
    },
    { $group: { _id: "$_id.viewer.kind", viewers: { $sum: 1 } } },
  ])) as Array<{ viewers?: number }>;
  return rows.reduce((a, r) => a + (typeof r.viewers === "number" ? r.viewers : 0), 0);
}

/** `/shareviews` `totals.visitTimeMs`, recomputed. */
async function freshVisitTimeMs(docId: Types.ObjectId, start: Date): Promise<number> {
  const rows = (await ShareVisitModel.aggregate([
    { $match: { docId, ...RECIPIENT_ONLY_MATCH, lastEventAt: { $gte: start } } },
    { $group: { _id: null, ms: { $sum: { $ifNull: ["$timeSpentMs", 0] } } } },
  ])) as Array<{ ms?: number }>;
  const ms = rows[0]?.ms;
  return typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
}

/** Invariants 5-13 for one document. */
async function checkReading(docId: Types.ObjectId): Promise<Failure[]> {
  const doc = await DocModel.findOne({ _id: docId, isDeleted: { $ne: true } })
    .select({ _id: 1, slideNodes: 1, pageSlugs: 1 })
    .lean<DocPagesInput & { _id: Types.ObjectId }>();
  if (!doc) return [];

  const failures: Failure[] = [];
  const scope = `doc ${String(docId)}`;
  const fail = (invariant: string, detail: string, where = scope) => failures.push({ invariant, scope: where, detail });

  const now = Date.now();
  const start = windowStartUtc(READING_DAYS, new Date(now));
  const core = await loadReadingCore({ docId, doc, days: READING_DAYS, now });
  const [viewerCount, visitTimeMs, tv2Visits] = await Promise.all([
    freshViewerCount(docId, start),
    freshVisitTimeMs(docId, start),
    ShareVisitModel.find({ docId, ...RECIPIENT_ONLY_MATCH, timingVersion: 2, lastEventAt: { $gte: start } })
      .select({ _id: 1, shareId: 1, timeSpentMs: 1, pageEvents: 1 })
      .lean<Array<{ _id: unknown; shareId?: string; timeSpentMs?: number; pageEvents?: Array<Record<string, unknown>> }>>(),
  ]);
  const r = buildReadingResponse(core, {
    tier: "deep",
    days: READING_DAYS,
    daysLimit: null,
    shareId: null,
    matrixLimit: MATRIX_ALL_LIMIT,
    now,
  });
  const P = core.P;
  const N = r.peopleWithDetail ?? 0;
  const pages = r.pages ?? [];
  const matrixRows = r.matrix?.rows ?? [];

  // 5. Timed page segments fit inside visit time.
  for (const v of tv2Visits) {
    let pageMs = 0;
    for (const ev of v.pageEvents ?? []) {
      const page = ev.pageNumber;
      const d = ev.durationMs;
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > P) continue;
      if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) continue;
      if (toMs(ev.enteredAt as Date | null) === null || toMs(ev.leftAt as Date | null) === null) continue;
      pageMs += d;
    }
    const total = typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) ? v.timeSpentMs : 0;
    if (pageMs > total + VISIT_TOLERANCE_MS) {
      fail(
        "page segments fit inside visit time",
        `timed page events sum to ${pageMs}ms but the visit's total is ${total}ms`,
        `sharevisit ${String(v._id)} (${v.shareId ?? "?"})`,
      );
    }
  }
  for (const p of core.people) {
    if (!p.visits.length || !p.visits.every((v) => v.tv2)) continue;
    const cellMs = p.cells.reduce((a, c) => a + c.ms, 0);
    if (cellMs > p.totalMs + VISIT_TOLERANCE_MS * p.visits.length) {
      fail(
        "page segments fit inside visit time",
        `page cells sum to ${cellMs}ms but ${p.visits.length} visit(s) total ${p.totalMs}ms`,
        `${scope} person ${p.personId}`,
      );
    }
  }

  // 6. One cell per page, one table row per page.
  if (pages.length !== P) fail("one row and one cell per page", `pages has ${pages.length} rows for pageCount ${P}`);
  for (const row of matrixRows) {
    if (row.cells.length !== P) {
      fail("one row and one cell per page", `matrix row has ${row.cells.length} cells for pageCount ${P}`, `${scope} person ${row.personId}`);
    }
  }

  // 7. Person endpoint vs matrix.
  const byKeyId = new Map(core.people.map((p) => [p.personId, p]));
  for (const row of matrixRows) {
    const person = byKeyId.get(row.personId);
    const where = `${scope} person ${row.personId}`;
    if (!person) {
      fail("person endpoint matches the matrix", "matrix row has no person", where);
      continue;
    }
    const pr = buildPersonResponse(core, person, { days: READING_DAYS, now });
    const msMismatch = pr.pages.findIndex((pg, i) => pg.ms !== (row.cells[i]?.ms ?? 0));
    if (pr.pages.length !== row.cells.length || msMismatch !== -1) {
      fail("person endpoint matches the matrix", `page ms differ (first at page ${msMismatch + 1})`, where);
    }
    if (pr.facts.reachedCount !== row.reachedCount || pr.facts.exitPage !== row.exitPage || pr.facts.totalMs !== row.totalMs) {
      fail(
        "person endpoint matches the matrix",
        `facts reached ${pr.facts.reachedCount}/exit ${pr.facts.exitPage}/total ${pr.facts.totalMs} vs matrix ${row.reachedCount}/${row.exitPage}/${row.totalMs}`,
        where,
      );
    }
  }

  // 8. Same people basis as /shareviews.
  if (r.people !== viewerCount) {
    fail("people equals the shareviews viewer count", `people ${r.people} but a fresh viewer-count aggregate says ${viewerCount}`);
  }

  // 9. Links add up.
  const linkPeople = r.links.reduce((a, l) => a + l.people, 0);
  if (linkPeople !== r.people) fail("links add up to people", `links sum to ${linkPeople} people but the document has ${r.people}`);

  // 10. Opened-ever fields are consistent.
  const openedRows: Array<{ where: string; people: number; everOpened: boolean; lastOpenedAt: string | null; lastOpenedAtAllTime: string | null }> = [
    { where: scope, people: r.people, everOpened: r.everOpened, lastOpenedAt: r.lastOpenedAt, lastOpenedAtAllTime: r.lastOpenedAtAllTime },
    ...r.links.map((l) => ({ where: `${scope} link ${l.shareId}`, ...l })),
  ];
  for (const o of openedRows) {
    if (o.everOpened !== (o.lastOpenedAtAllTime !== null)) {
      fail("opened-ever fields agree", `everOpened ${o.everOpened} with lastOpenedAtAllTime ${o.lastOpenedAtAllTime}`, o.where);
    }
    if (o.people > 0 && !(o.everOpened && o.lastOpenedAt === o.lastOpenedAtAllTime)) {
      fail(
        "opened-ever fields agree",
        `${o.people} people in range but lastOpenedAt ${o.lastOpenedAt} vs all-time ${o.lastOpenedAtAllTime}`,
        o.where,
      );
    }
  }

  // 11. Not-opened rows are links nobody opened.
  const linkById = new Map(r.links.map((l) => [l.shareId, l]));
  for (const a of r.attention.rows) {
    if (a.kind !== "not_opened") continue;
    const l = linkById.get(a.shareId);
    if (!l || l.everOpened) {
      fail("not-opened rows were never opened", l ? "link row says everOpened" : "link row missing", `${scope} link ${a.shareId}`);
    }
  }

  // 12. Typical time needs 3 people who stayed.
  for (const pg of pages) {
    if ((pg.typicalMs === null) !== (pg.readCount < 3)) {
      fail("typical time shown only from 3 people", `page ${pg.page}: typicalMs ${pg.typicalMs} with readCount ${pg.readCount}`);
    }
  }

  // 13. Total time.
  if (r.matrix && r.matrix.total <= MATRIX_ALL_LIMIT) {
    const rowsMs = matrixRows.reduce((a, row) => a + row.totalMs, 0);
    if (r.totalMs < rowsMs) fail("total time covers the matrix", `totalMs ${r.totalMs} is below the matrix rows' ${rowsMs}`);
  }
  if (r.coverage && r.coverage.unmatchedVisits === 0 && !r.coverage.truncated && r.totalMs !== visitTimeMs) {
    fail("total time equals shareviews visitTimeMs", `totalMs ${r.totalMs} but a fresh visitTimeMs aggregate says ${visitTimeMs}`);
  }
  const gate = calloutGateText(r.people, N);
  if ((r.calloutGate ?? null) !== gate) fail("callout gate follows the counts", `calloutGate ${JSON.stringify(r.calloutGate)} expected ${JSON.stringify(gate)}`);
  if ((r.callouts === null || r.callouts === undefined) !== N < 5) {
    fail("callout gate follows the counts", `callouts ${r.callouts ? "present" : "null"} with ${N} people with page detail`);
  }

  return failures;
}

/** {@link checkReading}, re-read once when only a two-read comparison failed, since live traffic can land between the reads. */
async function checkReadingSettled(docId: Types.ObjectId): Promise<Failure[]> {
  const first = await checkReading(docId);
  if (!first.length || !first.every((f) => READ_RACE_INVARIANTS.has(f.invariant))) return first;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return checkReading(docId);
}

async function main(): Promise<void> {
  const quiet = process.argv.includes("--quiet");
  const docRaw = argValue("--doc");
  if (docRaw && !Types.ObjectId.isValid(docRaw)) throw new Error(`--doc must be an ObjectId, got ${docRaw}`);
  await connectMongo();

  const docId = docRaw ? new Types.ObjectId(docRaw) : null;
  const docIds: Types.ObjectId[] = docId
    ? [docId]
    : ((await ShareLinkModel.distinct("docId")) as unknown as Types.ObjectId[]);

  const failures: Failure[] = [
    ...(await checkPageTimeFitsTotal(ShareViewModel as never, "shareview", docId)),
    ...(await checkPageTimeFitsTotal(ShareVisitModel as never, "sharevisit", docId)),
    ...(await checkOwnerPreviewSanity(docId)),
  ];
  for (const id of docIds) failures.push(...(await checkDocument(id)));
  const readingBefore = failures.length;
  for (const id of docIds) failures.push(...(await checkReadingSettled(id)));

  if (!quiet) {
    log(`Checked ${docIds.length} document(s) with links.`);
    log(`Reading invariants 5-13 (${READING_DAYS} days): ${failures.length - readingBefore} failure(s).`);
  }
  if (!failures.length) {
    log("All share-analytics invariants hold.");
    process.exit(0);
  }
  log(`${failures.length} invariant failure(s):`);
  for (const f of failures) log(`  [${f.invariant}] ${f.scope}: ${f.detail}`);
  // Counter drift is repairable and a nightly job already does it. A page-time overrun is a code
  // bug: the ingest counted an interval twice, and repairing the rows would hide it.
  log("");
  log("Counter drift is repairable with: npm run cron:analytics-reconcile");
  log("A page-time overrun is not — it means the ingest double counted. See src/lib/analytics/shareTiming.ts.");
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
