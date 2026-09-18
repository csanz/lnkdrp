import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { RECIPIENT_ONLY_MATCH, activityWindowMatch, shareIdClause } from "@/lib/analytics/shareViewAggregates";
import { projectLinkSlugsForDocs } from "@/lib/analytics/docScope";

/**
 * Server-side metrics rollups.
 *
 * Periodically aggregates per-doc share views/downloads into a denormalized
 * `metricsSnapshot` on the Doc model for fast UI queries.
 */

/** Convert a Date to an ISO `YYYY-MM-DD` key in UTC. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a value into a positive integer (>= 1), otherwise return null. */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/**
 * Roll up share metrics for a set of docs (or a single doc).
 *
 * - `days`: how many trailing UTC days to include in "lastDays" metrics
 * - `limit`: maximum docs processed per run (when `docId` is not provided)
 */
export async function rollupDocMetrics(opts?: {
  docId?: string;
  limit?: number;
  days?: number;
}): Promise<{
  ok: true;
  processed: number;
  days: number;
  docIds: string[];
  viewsLastDaysTotal: number;
  downloadsLastDaysTotal: number;
  downloadsTotalTotal: number;
}> {
  const days = Math.min(60, asPositiveInt(opts?.days) ?? 15);
  const limit = Math.min(500, asPositiveInt(opts?.limit) ?? 50);

  await connectMongo();

  const query: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (opts?.docId) {
    if (!Types.ObjectId.isValid(opts.docId)) {
      return {
        ok: true,
        processed: 0,
        days,
        docIds: [] as string[],
        viewsLastDaysTotal: 0,
        downloadsLastDaysTotal: 0,
        downloadsTotalTotal: 0,
      };
    }
    query._id = new Types.ObjectId(opts.docId);
  }

  // Stalest snapshot first (MongoDB sorts null/missing before dates ascending),
  // so every doc is eventually rolled up instead of the same `limit` docs each run.
  const docs = await DocModel.find(query)
    .sort({ "metricsSnapshot.updatedAt": 1, _id: 1 })
    .select({ _id: 1, shareAllowPdfDownload: 1 })
    .limit(limit)
    .lean();

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startKey = utcDayKey(start);
  const now = new Date();

  /**
   * The project-link slugs these documents have traffic on, excluded from every figure below.
   *
   * A read through a project link is the *project's* view, not the document's (docs/METRICS.md,
   * `@/lib/analytics/docScope`), and the live route `/api/docs/:docId/shareviews` has always said
   * so. This snapshot did not, so `metricsSnapshot.lastDaysViews` exceeded what the metrics page
   * reported for the same document and the same window: QuickStats rendered the snapshot, flashed
   * the larger number, then swapped to the smaller one when the route answered, and the dashboard
   * card — which never calls the route — disagreed permanently.
   *
   * Computed once for the whole batch, not per document: a project slug is a project slug for
   * every document in it, so one pair of queries answers for all of them.
   */
  const foreignShareIds = await projectLinkSlugsForDocs(docs.map((d) => String(d._id)));
  const docOnlyMatch = shareIdClause({ except: foreignShareIds });

  const processedIds: string[] = [];
  let viewsLastDaysTotal = 0;
  let downloadsLastDaysTotal = 0;
  let downloadsTotalTotal = 0;

  for (const doc of docs) {
    const docId = new Types.ObjectId(String(doc._id));

    // Same two rules as the live metrics route, or the snapshot on the dashboard card disagrees
    // with the page it links to: recipients only, bounded by last activity rather than first sighting.
    const lastDaysViews = await ShareViewModel.countDocuments({
      docId,
      ...docOnlyMatch,
      ...RECIPIENT_ONLY_MATCH,
      ...activityWindowMatch(start),
    });

    const downloadsLastAgg = (await ShareViewModel.aggregate([
      { $match: { docId, ...docOnlyMatch, ...RECIPIENT_ONLY_MATCH } },
      { $project: { items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
      { $unwind: "$items" },
      { $match: { "items.k": { $gte: startKey } } },
      { $group: { _id: null, downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
    ])) as Array<{ downloads?: number }>;
    const lastDaysDownloads =
      downloadsLastAgg && downloadsLastAgg[0] && typeof downloadsLastAgg[0].downloads === "number"
        ? downloadsLastAgg[0].downloads
        : 0;

    const downloadsTotalAgg = (await ShareViewModel.aggregate([
      { $match: { docId, ...docOnlyMatch, ...RECIPIENT_ONLY_MATCH } },
      { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
    ])) as Array<{ downloads?: number }>;
    const downloadsTotal =
      downloadsTotalAgg && downloadsTotalAgg[0] && typeof downloadsTotalAgg[0].downloads === "number"
        ? downloadsTotalAgg[0].downloads
        : 0;

    viewsLastDaysTotal += lastDaysViews;
    downloadsLastDaysTotal += lastDaysDownloads;
    downloadsTotalTotal += downloadsTotal;

    await DocModel.updateOne(
      { _id: docId },
      {
        $set: {
          metricsSnapshot: {
            updatedAt: now,
            days,
            lastDaysViews,
            lastDaysDownloads,
            downloadsTotal,
          },
        },
      },
    );

    processedIds.push(String(docId));
  }

  return {
    ok: true,
    processed: processedIds.length,
    days,
    docIds: processedIds,
    viewsLastDaysTotal,
    downloadsLastDaysTotal,
    downloadsTotalTotal,
  };
}