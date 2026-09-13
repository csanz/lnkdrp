/**
 * Owner doc share-view metrics API (views/downloads + viewer breakdown).
 * Route: `/api/docs/:docId/shareviews`
 *
 * Analytics tiers (see `src/lib/billing/planLimits.ts`):
 * - `analyticsTier: "basic"` (Free): totals, views-by-day series, total time on document and a
 *   unique `viewerCount` for the (clamped) window. `viewers` / `anonymousViewers` are always `[]`
 *   and per-page maps are omitted, so no viewer identity, per-viewer row or per-page time leaves
 *   the server. Identities are still recorded; upgrading reveals them retroactively.
 * - `analyticsTier: "deep"` (Pro): everything, including viewer rows with `?viewers=1`.
 *
 * Multiple links per document (docs/prds/lnkdrp-multi-links.md): without `?shareId=` every number
 * covers the whole document (all of its links); with `?shareId=<slug>` the same response is scoped
 * to that one link. The response shape is identical either way.
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
import { analyticsTierForPlan, clampAnalyticsDays, getWorkspacePlan, limitsForPlan } from "@/lib/billing/planLimits";
import { listShareLinks } from "@/lib/share/links";

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
 * Merge an array of objects like [{k, v}] into a summed object.
 * (Used in Mongo aggregation projections.)
 */
const MERGE_PAGE_TIME_OBJECTS = {
  $let: {
    vars: {
      allItems: {
        $reduce: {
          input: "$pageTimeItemsArrays",
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      },
    },
    in: {
      $arrayToObject: {
        $map: {
          input: { $setUnion: [{ $map: { input: "$$allItems", as: "it", in: "$$it.k" } }, []] },
          as: "k",
          in: {
            k: "$$k",
            v: {
              $sum: {
                $map: {
                  input: "$$allItems",
                  as: "it",
                  in: { $cond: [{ $eq: ["$$it.k", "$$k"] }, { $ifNull: ["$$it.v", 0] }, 0] },
                },
              },
            },
          },
        },
      },
    },
  },
};
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

      const requestedDays = Math.min(60, asPositiveInt(url.searchParams.get("days")) ?? 15);
      /** Optional per-link filter: the slug of one of the document's share links. */
      const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
      const wantsViewers = url.searchParams.get("viewers") === "1";
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
          orgId: 1,
          title: 1,
          numberOfViews: 1,
          numberOfPagesViewed: 1,
          shareAllowPdfDownload: 1,
        })
        .lean();

      if (!doc) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      // Plan limits: Free workspaces only see the last `FREE_ANALYTICS_DAYS` days. Legacy docs may
      // lack `orgId`; they belong to the actor's (personal) workspace.
      const docOrgIdRaw = (doc as unknown as { orgId?: unknown }).orgId;
      const plan = await getWorkspacePlan(docOrgIdRaw ? String(docOrgIdRaw) : actor.orgId);
      const days = clampAnalyticsDays(plan, requestedDays);
      const analyticsDaysLimit = limitsForPlan(plan).analyticsDays;
      // Basic (Free) never runs the identity aggregates: viewer rows are withheld, not just hidden.
      const analyticsTier = analyticsTierForPlan(plan);
      const includeViewers = analyticsTier === "deep" && wantsViewers;

      const docObjectId = new Types.ObjectId(docId);

      // `?shareId=` scopes every aggregate to one link of this document; without it the numbers
      // cover the document (all its links). An unknown slug is a 404, not a silent whole-doc read.
      const link = shareIdFilter
        ? (await listShareLinks({ orgId: docOrgIdRaw ? String(docOrgIdRaw) : actor.orgId, docId: docObjectId, includeArchived: true })).find(
            (l) => l.shareId === shareIdFilter,
          ) ?? null
        : null;
      if (shareIdFilter && !link) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }
      /** What every `ShareView` aggregate matches on: one link, or the whole document. */
      const scopeMatch: Record<string, unknown> = link ? { shareId: link.shareId } : { docId: docObjectId };

      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - (days - 1));

      const startKey = utcDayKey(start);
      const downloadsEnabled = link
        ? Boolean(link.allowDownload)
        : Boolean((doc as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload);

      // Document totals come from the denormalized counters; a per-link read recomputes them from
      // the link's own rows (`numberOfViews` is incremented once per new ShareView row, so the two
      // agree by construction).
      const linkTotals = link
        ? ((
            await ShareViewModel.aggregate([
              { $match: { shareId: link.shareId } },
              { $group: { _id: null, views: { $sum: 1 }, pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } } } },
              {
                $project: {
                  _id: 0,
                  views: 1,
                  pagesViewed: {
                    $size: { $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
                  },
                },
              },
            ])
          )[0] as { views?: number; pagesViewed?: number } | undefined) ?? { views: 0, pagesViewed: 0 }
        : null;

      const totalViews = linkTotals
        ? (typeof linkTotals.views === "number" ? linkTotals.views : 0)
        : typeof (doc as any).numberOfViews === "number"
          ? (doc as any).numberOfViews
          : 0;
      const pagesViewed = linkTotals
        ? (typeof linkTotals.pagesViewed === "number" ? linkTotals.pagesViewed : 0)
        : typeof doc.numberOfPagesViewed === "number"
          ? doc.numberOfPagesViewed
          : 0;

      const series: Array<{ date: string; views: number; downloads: number }> = [];
      let totalDownloads = 0;
      if (!viewersOnly) {
        const [seriesAgg, downloadsSeriesAgg, downloadsAgg] = await Promise.all([
          ShareViewModel.aggregate([
            { $match: { ...scopeMatch, createdDate: { $gte: start } } },
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
                { $match: { ...scopeMatch } },
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
                { $match: { ...scopeMatch } },
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
              { $match: { ...scopeMatch, viewerUserId: { $ne: null } } },
              // Ensure we pick the most recent denormalized viewerName/email snapshots.
              { $sort: { updatedDate: -1 } },
              {
                $group: {
                  _id: "$viewerUserId",
                  firstSeen: { $min: "$createdDate" },
                  lastSeen: { $max: "$updatedDate" },
                  views: { $sum: 1 },
                  pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
                  timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } },
                  pageTimeMaps: { $push: { $ifNull: ["$pageTimeMsByPage", {}] } },
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
                  timeSpentMs: 1,
                  viewerName: 1,
                  viewerEmailSnapshot: 1,
                  pageTimeItemsArrays: {
                    $map: {
                      input: "$pageTimeMaps",
                      as: "m",
                      in: { $objectToArray: { $ifNull: ["$$m", {}] } },
                    },
                  },
                  pageTimeMsByPage: MERGE_PAGE_TIME_OBJECTS,
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
              { $unset: ["pageTimeItemsArrays", "pageTimeMaps"] },
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
                timeSpentMs?: number;
                pageTimeMsByPage?: Record<string, number>;
                viewerName?: string | null;
                viewerEmailSnapshot?: string | null;
              }>
            >,
            ShareViewModel.aggregate([
              { $match: { ...scopeMatch, $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] } },
              { $sort: { updatedDate: -1 } },
              {
                $group: {
                  _id: "$botIdHash",
                  firstSeen: { $min: "$createdDate" },
                  lastSeen: { $max: "$updatedDate" },
                  views: { $sum: 1 },
                  pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
                  timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } },
                  pageTimeMaps: { $push: { $ifNull: ["$pageTimeMsByPage", {}] } },
                  viewerName: { $first: "$viewerName" },
                  viewerEmailSnapshot: { $first: "$viewerEmailSnapshot" },
                },
              },
              {
                $project: {
                  _id: 0,
                  botIdHash: "$_id",
                  firstSeen: 1,
                  lastSeen: 1,
                  views: 1,
                  timeSpentMs: 1,
                  viewerName: 1,
                  viewerEmailSnapshot: 1,
                  pageTimeItemsArrays: {
                    $map: {
                      input: "$pageTimeMaps",
                      as: "m",
                      in: { $objectToArray: { $ifNull: ["$$m", {}] } },
                    },
                  },
                  pageTimeMsByPage: MERGE_PAGE_TIME_OBJECTS,
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
              { $unset: ["pageTimeItemsArrays", "pageTimeMaps"] },
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
                timeSpentMs?: number;
                pageTimeMsByPage?: Record<string, number>;
                viewerName?: string | null;
                viewerEmailSnapshot?: string | null;
              }>
            >,
          ])
        : [[], []];

      // Window summary (both tiers): unique viewers and total time on the document within `days`.
      // Groups by viewer identity without projecting it, so it is safe to run on Basic.
      const windowAgg = (await ShareViewModel.aggregate([
        { $match: { ...scopeMatch, createdDate: { $gte: start } } },
        {
          $group: {
            _id: {
              $cond: [
                { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
                { kind: "user", key: { $toString: "$viewerUserId" } },
                { kind: "anon", key: { $ifNull: ["$botIdHash", ""] } },
              ],
            },
            timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } },
          },
        },
        { $group: { _id: "$_id.kind", viewers: { $sum: 1 }, timeSpentMs: { $sum: "$timeSpentMs" } } },
      ])) as Array<{ _id: "user" | "anon"; viewers?: number; timeSpentMs?: number }>;
      let windowAuthedViewers = 0;
      let windowAnonymousViewers = 0;
      let windowTimeSpentMs = 0;
      for (const row of windowAgg) {
        const n = typeof row.viewers === "number" && Number.isFinite(row.viewers) ? row.viewers : 0;
        if (row._id === "user") windowAuthedViewers += n;
        else windowAnonymousViewers += n;
        windowTimeSpentMs += typeof row.timeSpentMs === "number" && Number.isFinite(row.timeSpentMs) ? row.timeSpentMs : 0;
      }
      const viewerCount = windowAuthedViewers + windowAnonymousViewers;

      // Deep keeps the all-time breakdown from the viewer rows (when requested); Basic reports the
      // window counts so the UI can still say "4 people viewed this" without any identity.
      const uniqueAuthedViewers =
        analyticsTier === "deep" ? (includeViewers ? viewersAgg.length : 0) : windowAuthedViewers;
      const uniqueAnonymousViewers =
        analyticsTier === "deep" ? (includeViewers ? anonymousAgg.length : 0) : windowAnonymousViewers;

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
        /** Plan cap on the window (`null` = unlimited); when `days < requested`, the UI can explain the clamp. */
        analyticsDaysLimit,
        /** `"basic"` (Free: no viewer identities / per-page data) or `"deep"` (Pro: everything). */
        analyticsTier,
        /** Unique viewers (signed-in + anonymous) within the window; available on both tiers. */
        viewerCount,
        totals: {
          views: totalViews,
          downloads: totalDownloads,
          pagesViewed,
          /** Total time on the document within the window (ms), summed across all viewers. */
          timeSpentMs: Math.max(0, Math.floor(windowTimeSpentMs)),
          authenticatedViewers: uniqueAuthedViewers,
          anonymousViewers: uniqueAnonymousViewers,
        },
        downloadsEnabled,
        series,
        // On Basic both viewer arrays are `[]` (the aggregates never run), which also omits the
        // per-viewer `pageTimeMsByPage` / `pagesSeen` maps.
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
            timeSpentMs:
              typeof (v as any).timeSpentMs === "number" && Number.isFinite((v as any).timeSpentMs)
                ? Math.max(0, Math.floor((v as any).timeSpentMs))
                : 0,
            pageTimeMsByPage:
              (v as any).pageTimeMsByPage && typeof (v as any).pageTimeMsByPage === "object" ? (v as any).pageTimeMsByPage : {},
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
            name: typeof (v as any).viewerName === "string" ? (v as any).viewerName : null,
            email: typeof (v as any).viewerEmailSnapshot === "string" ? (v as any).viewerEmailSnapshot : null,
            views: typeof v.views === "number" ? v.views : 0,
            timeSpentMs:
              typeof (v as any).timeSpentMs === "number" && Number.isFinite((v as any).timeSpentMs)
                ? Math.max(0, Math.floor((v as any).timeSpentMs))
                : 0,
            pageTimeMsByPage:
              (v as any).pageTimeMsByPage && typeof (v as any).pageTimeMsByPage === "object" ? (v as any).pageTimeMsByPage : {},
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


