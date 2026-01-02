import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";

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
}> {
  const days = Math.min(60, asPositiveInt(opts?.days) ?? 15);
  const limit = Math.min(500, asPositiveInt(opts?.limit) ?? 50);

  await connectMongo();

  const query: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (opts?.docId) {
    if (!Types.ObjectId.isValid(opts.docId)) {
      return { ok: true, processed: 0, days, docIds: [] };
    }
    query._id = new Types.ObjectId(opts.docId);
  }

  const docs = await DocModel.find(query)
    .select({ _id: 1, shareAllowPdfDownload: 1 })
    .limit(limit)
    .lean();

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startKey = utcDayKey(start);
  const now = new Date();

  const processedIds: string[] = [];

  for (const doc of docs) {
    const docId = new Types.ObjectId(String(doc._id));

    const lastDaysViews = await ShareViewModel.countDocuments({
      docId,
      createdDate: { $gte: start },
    });

    const downloadsLastAgg = (await ShareViewModel.aggregate([
      { $match: { docId } },
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
      { $match: { docId } },
      { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
    ])) as Array<{ downloads?: number }>;
    const downloadsTotal =
      downloadsTotalAgg && downloadsTotalAgg[0] && typeof downloadsTotalAgg[0].downloads === "number"
        ? downloadsTotalAgg[0].downloads
        : 0;

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

  return { ok: true, processed: processedIds.length, days, docIds: processedIds };
}