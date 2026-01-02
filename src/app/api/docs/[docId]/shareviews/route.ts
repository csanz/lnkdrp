import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * As Positive Int (uses Number, isFinite, floor).
 */


function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}
/**
 * Utc Day Key (uses slice, toISOString).
 */


function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/**
 * Handle GET requests.
 */


export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const actor = await resolveActor(request);
  try {
    const { docId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }

    const url = new URL(request.url);
    const days = Math.min(60, asPositiveInt(url.searchParams.get("days")) ?? 15);

    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const doc = await DocModel.findOne({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
              {
                _id: new Types.ObjectId(docId),
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } }),
    })
      .select({ _id: 1, numberOfPagesViewed: 1, shareAllowPdfDownload: 1 })
      .lean();

    if (!doc) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const docObjectId = new Types.ObjectId(docId);

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));

    const seriesAgg = (await ShareViewModel.aggregate([
      { $match: { docId: docObjectId, createdDate: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { date: "$createdDate", format: "%Y-%m-%d", timezone: "UTC" } },
          views: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])) as Array<{ _id: string; views: number }>;

    const byDay = new Map<string, number>(seriesAgg.map((x) => [x._id, x.views]));
    const startKey = utcDayKey(start);
    const downloadsSeriesAgg = (await ShareViewModel.aggregate([
      { $match: { docId: docObjectId } },
      {
        $project: {
          items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } },
        },
      },
      { $unwind: "$items" },
      { $match: { "items.k": { $gte: startKey } } },
      { $group: { _id: "$items.k", downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
      { $sort: { _id: 1 } },
    ])) as Array<{ _id: string; downloads: number }>;
    const downloadsByDay = new Map<string, number>(downloadsSeriesAgg.map((x) => [x._id, x.downloads]));

    const series: Array<{ date: string; views: number; downloads: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = utcDayKey(d);
      series.push({ date: key, views: byDay.get(key) ?? 0, downloads: downloadsByDay.get(key) ?? 0 });
    }

    const totalViews = await ShareViewModel.countDocuments({ docId: docObjectId });
    const downloadsAgg = (await ShareViewModel.aggregate([
      { $match: { docId: docObjectId } },
      { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
    ])) as Array<{ downloads?: number }>;
    const totalDownloads =
      downloadsAgg && downloadsAgg[0] && typeof downloadsAgg[0].downloads === "number"
        ? downloadsAgg[0].downloads
        : 0;
    const authedUserIds = await ShareViewModel.distinct("viewerUserId", {
      docId: docObjectId,
      viewerUserId: { $ne: null },
    });
    const uniqueAuthedViewers = Array.isArray(authedUserIds)
      ? authedUserIds.filter((x) => Types.ObjectId.isValid(String(x))).length
      : 0;

    const viewersAgg = (await ShareViewModel.aggregate([
      { $match: { docId: docObjectId, viewerUserId: { $ne: null } } },
      {
        $group: {
          _id: "$viewerUserId",
          firstSeen: { $min: "$createdDate" },
          lastSeen: { $max: "$updatedDate" },
          views: { $sum: 1 },
        },
      },
      { $sort: { lastSeen: -1 } },
      { $limit: 100 },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          viewerUserId: "$_id",
          firstSeen: 1,
          lastSeen: 1,
          views: 1,
          user: { email: "$user.email", name: "$user.name" },
        },
      },
    ])) as Array<{
      viewerUserId: Types.ObjectId;
      firstSeen: Date;
      lastSeen: Date;
      views: number;
      user?: { email?: string | null; name?: string | null } | null;
    }>;

    const res = NextResponse.json({
      ok: true,
      days,
      totals: {
        views: totalViews,
        downloads: totalDownloads,
        pagesViewed: typeof doc.numberOfPagesViewed === "number" ? doc.numberOfPagesViewed : 0,
        authenticatedViewers: uniqueAuthedViewers,
      },
      downloadsEnabled: Boolean((doc as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload),
      series,
      viewers: viewersAgg.map((v) => ({
        userId: String(v.viewerUserId),
        name: typeof v.user?.name === "string" ? v.user.name : null,
        email: typeof v.user?.email === "string" ? v.user.email : null,
        views: typeof v.views === "number" ? v.views : 0,
        firstSeen: v.firstSeen ? new Date(v.firstSeen).toISOString() : null,
        lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
      })),
    });
    return applyTempUserHeaders(res, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


