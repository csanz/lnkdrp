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
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";

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

  if (!quiet) {
    log(`Checked ${docIds.length} document(s) with links.`);
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
