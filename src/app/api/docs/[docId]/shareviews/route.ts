/**
 * Owner doc share-view metrics API (views/downloads + viewer breakdown).
 * Route: `/api/docs/:docId/shareviews`
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { after } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { UserModel } from "@/lib/models/User";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
  return withMongoRequestLogging(request, async () => {
    const url = new URL(request.url);
    const lite = url.searchParams.get("lite") === "1";
    const actor = (lite ? await tryResolveUserActorFast(request) : null) ?? (await resolveActor(request));
    try {
      const { docId } = await ctx.params;
      if (!Types.ObjectId.isValid(docId)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
      }

      const days = Math.min(60, asPositiveInt(url.searchParams.get("days")) ?? 15);
      const includeViewers = url.searchParams.get("viewers") === "1";
      const viewersOnly = url.searchParams.get("viewersOnly") === "1";

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
        .select({
          _id: 1,
          title: 1,
          numberOfViews: 1,
          numberOfPagesViewed: 1,
          shareAllowPdfDownload: 1,
        })
        .lean();

      if (!doc) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const docObjectId = new Types.ObjectId(docId);

      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - (days - 1));

      const startKey = utcDayKey(start);
      const downloadsEnabled = Boolean((doc as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload);

      const totalViews = typeof (doc as any).numberOfViews === "number" ? (doc as any).numberOfViews : 0;
      const pagesViewed = typeof doc.numberOfPagesViewed === "number" ? doc.numberOfPagesViewed : 0;

      const series: Array<{ date: string; views: number; downloads: number }> = [];
      let totalDownloads = 0;
      if (!viewersOnly) {
        const [seriesAgg, downloadsSeriesAgg, downloadsAgg] = await Promise.all([
          ShareViewModel.aggregate([
            { $match: { docId: docObjectId, createdDate: { $gte: start } } },
            {
              $group: {
                _id: { $dateToString: { date: "$createdDate", format: "%Y-%m-%d", timezone: "UTC" } },
                views: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ]) as Promise<Array<{ _id: string; views: number }>>,
          downloadsEnabled
            ? (ShareViewModel.aggregate([
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
              ]) as Promise<Array<{ _id: string; downloads: number }>>)
            : Promise.resolve([] as Array<{ _id: string; downloads: number }>),
          downloadsEnabled
            ? (ShareViewModel.aggregate([
                { $match: { docId: docObjectId } },
                { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
              ]) as Promise<Array<{ downloads?: number }>>)
            : Promise.resolve([] as Array<{ downloads?: number }>),
        ]);

        const byDay = new Map<string, number>(seriesAgg.map((x) => [x._id, x.views]));
        const downloadsByDay = new Map<string, number>(downloadsSeriesAgg.map((x) => [x._id, x.downloads]));
        for (let i = 0; i < days; i++) {
          const d = new Date(start);
          d.setUTCDate(start.getUTCDate() + i);
          const key = utcDayKey(d);
          series.push({ date: key, views: byDay.get(key) ?? 0, downloads: downloadsByDay.get(key) ?? 0 });
        }

        totalDownloads =
          downloadsAgg && downloadsAgg[0] && typeof downloadsAgg[0].downloads === "number" ? downloadsAgg[0].downloads : 0;
      }

      const [viewersAgg, anonymousAgg] = includeViewers
        ? await Promise.all([
            ShareViewModel.aggregate([
              { $match: { docId: docObjectId, viewerUserId: { $ne: null } } },
              // Ensure we pick the most recent denormalized viewerName/email snapshots.
              { $sort: { updatedDate: -1 } },
              {
                $group: {
                  _id: "$viewerUserId",
                  firstSeen: { $min: "$createdDate" },
                  lastSeen: { $max: "$updatedDate" },
                  views: { $sum: 1 },
                  pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
                  viewerName: { $first: "$viewerName" },
                  viewerEmailSnapshot: { $first: "$viewerEmailSnapshot" },
                },
              },
              {
                $project: {
                  _id: 0,
                  viewerUserId: "$_id",
                  firstSeen: 1,
                  lastSeen: 1,
                  views: 1,
                  viewerName: 1,
                  viewerEmailSnapshot: 1,
                  pagesSeen: {
                    $reduce: {
                      input: "$pagesSeenArrays",
                      initialValue: [],
                      in: { $setUnion: ["$$value", "$$this"] },
                    },
                  },
                  pagesViewed: {
                    $size: {
                      $reduce: {
                        input: "$pagesSeenArrays",
                        initialValue: [],
                        in: { $setUnion: ["$$value", "$$this"] },
                      },
                    },
                  },
                },
              },
              { $sort: { lastSeen: -1 } },
              { $limit: 100 },
            ]) as Promise<
              Array<{
                viewerUserId: Types.ObjectId;
                firstSeen: Date;
                lastSeen: Date;
                views: number;
                pagesViewed: number;
                pagesSeen?: number[];
                viewerName?: string | null;
                viewerEmailSnapshot?: string | null;
              }>
            >,
            ShareViewModel.aggregate([
              { $match: { docId: docObjectId, $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] } },
              { $sort: { updatedDate: -1 } },
              {
                $group: {
                  _id: "$botIdHash",
                  firstSeen: { $min: "$createdDate" },
                  lastSeen: { $max: "$updatedDate" },
                  views: { $sum: 1 },
                  pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
                },
              },
              {
                $project: {
                  _id: 0,
                  botIdHash: "$_id",
                  firstSeen: 1,
                  lastSeen: 1,
                  views: 1,
                  pagesSeen: {
                    $reduce: {
                      input: "$pagesSeenArrays",
                      initialValue: [],
                      in: { $setUnion: ["$$value", "$$this"] },
                    },
                  },
                  pagesViewed: {
                    $size: {
                      $reduce: {
                        input: "$pagesSeenArrays",
                        initialValue: [],
                        in: { $setUnion: ["$$value", "$$this"] },
                      },
                    },
                  },
                },
              },
              { $sort: { lastSeen: -1 } },
              { $limit: 100 },
            ]) as Promise<
              Array<{
                botIdHash: string;
                firstSeen: Date;
                lastSeen: Date;
                views: number;
                pagesViewed: number;
                pagesSeen?: number[];
              }>
            >,
          ])
        : [[], []];

      const uniqueAuthedViewers = includeViewers ? viewersAgg.length : 0;
      const uniqueAnonymousViewers = includeViewers ? anonymousAgg.length : 0;

      // Best-effort background backfill for older ShareView rows that predate denormalized snapshots.
      // Keeps the read path join-free while allowing names/emails to appear over time.
      if (includeViewers) {
        const missingIds = viewersAgg
          .filter(
            (v) =>
              !(
                (typeof v.viewerName === "string" && v.viewerName.trim()) ||
                (typeof v.viewerEmailSnapshot === "string" && v.viewerEmailSnapshot.trim())
              ),
          )
          .map((v) => String(v.viewerUserId))
          .filter((id) => Types.ObjectId.isValid(id));
        if (missingIds.length) {
          after(async () => {
            try {
              const ids = Array.from(new Set(missingIds)).slice(0, 100);
              const users = await UserModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, isActive: { $ne: false } })
                .select({ _id: 1, name: 1, email: 1 })
                .lean();
              const ops = users
                .map((u) => {
                  const id = u?._id ? String(u._id) : "";
                  if (!id) return null;
                  const viewerName =
                    typeof (u as any).name === "string" && (u as any).name.trim() ? (u as any).name.trim() : null;
                  const viewerEmailSnapshot =
                    typeof (u as any).email === "string" && (u as any).email.trim()
                      ? String((u as any).email).trim().toLowerCase()
                      : null;
                  if (!viewerName && !viewerEmailSnapshot) return null;
                  return {
                    updateMany: {
                      filter: {
                        docId: docObjectId,
                        viewerUserId: new Types.ObjectId(id),
                        $or: [
                          { viewerName: { $exists: false } },
                          { viewerName: null },
                          { viewerEmailSnapshot: { $exists: false } },
                          { viewerEmailSnapshot: null },
                        ],
                      },
                      update: { $set: { ...(viewerName ? { viewerName } : {}), ...(viewerEmailSnapshot ? { viewerEmailSnapshot } : {}) } },
                    },
                  };
                })
                .filter(Boolean) as any[];
              if (ops.length) await ShareViewModel.bulkWrite(ops, { ordered: false });
            } catch {
              // ignore
            }
          });
        }
      }

      const res = NextResponse.json(
        {
        ok: true,
        docTitle: typeof (doc as any)?.title === "string" ? String((doc as any).title).trim() : "",
        days,
        totals: {
          views: totalViews,
          downloads: totalDownloads,
          pagesViewed,
          authenticatedViewers: uniqueAuthedViewers,
          anonymousViewers: uniqueAnonymousViewers,
        },
        downloadsEnabled,
        series,
        viewers: viewersAgg.map((v) => {
          const pagesSeen = Array.isArray((v as any).pagesSeen)
            ? ((v as any).pagesSeen as unknown[])
                .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null))
                .filter((n): n is number => Boolean(n && n >= 1))
                .sort((a, b) => a - b)
            : [];
          return {
            userId: String(v.viewerUserId),
            name: typeof v.viewerName === "string" ? v.viewerName : null,
            email: typeof v.viewerEmailSnapshot === "string" ? v.viewerEmailSnapshot : null,
            views: typeof v.views === "number" ? v.views : 0,
            pagesViewed: typeof v.pagesViewed === "number" ? v.pagesViewed : pagesSeen.length,
            pagesSeen,
            firstSeen: v.firstSeen ? new Date(v.firstSeen).toISOString() : null,
            lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
          };
        }),
        anonymousViewers: anonymousAgg.map((v) => {
          const pagesSeen = Array.isArray((v as any).pagesSeen)
            ? ((v as any).pagesSeen as unknown[])
                .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null))
                .filter((n): n is number => Boolean(n && n >= 1))
                .sort((a, b) => a - b)
            : [];
          return {
            botIdHash: typeof v.botIdHash === "string" ? v.botIdHash : "",
            views: typeof v.views === "number" ? v.views : 0,
            pagesViewed: typeof v.pagesViewed === "number" ? v.pagesViewed : pagesSeen.length,
            pagesSeen,
            firstSeen: v.firstSeen ? new Date(v.firstSeen).toISOString() : null,
            lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
          };
        }),
        },
        { headers: { "cache-control": "no-store" } },
      );
      return applyTempUserHeaders(res, actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}


