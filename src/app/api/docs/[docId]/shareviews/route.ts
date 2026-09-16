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
 *
 * One rule holds the two scopes together: **every figure comes from the same pipeline, and only
 * the `$match` changes** (`scopeMatch` is `{ shareId }` or `{ docId }`). No denormalized counter
 * is read here any more — `Doc.numberOfViews` / `Doc.numberOfPagesViewed` only survive as a
 * fallback for a document whose rows have been swept — because a counter and a row count drift
 * (the `/s/:shareId/pdf` download path creates rows, cleanup deletes them) and the drift is
 * visible now that the per-link table sits directly under the "All links" tile.
 *
 * Two consequences worth knowing:
 * - `totals` covers the `days` window, like `series` and `viewerCount`, so one response speaks one
 *   language. Lifetime figures are still returned, separately, as `totalsAllTime`.
 * - A window means "active in the window", bounded by last activity rather than by `createdDate`
 *   (see `activityWindowMatch`). A `ShareView` row is lifetime-per-(link, viewer), so the old
 *   `createdDate` bound answered "first seen this week" and hid the investor who received the link
 *   in January and re-read the deck this morning — the single event the owner most wants to see.
 * - Nothing here counts the owner's own opens. They are recorded (`ShareView.isOwnerPreview`, so
 *   "did my link work?" stays answerable) and excluded from every figure by `RECIPIENT_ONLY_MATCH`.
 *   How many were excluded is reported as `totals.ownerPreviews`, because a silent exclusion
 *   leaves "nobody opened it" and "only the owner opened it" looking identical. The flag is
 *   best-effort: it needs a signed-in session on the ingest request, so an owner opening their own
 *   link in a logged-out browser is counted as a recipient, and `ownerPreviews` is a floor.
 * - `opens` counts tab sessions (`ShareVisit`), the one figure here that counts events rather than
 *   recipients: a reader who came back three times is one view and three opens, and the gap
 *   between those two numbers is what a returning reader looks like. It is `0` for traffic older
 *   than the visit-upsert fix, which wrote no visit rows at all.
 * - `views`, `downloads` and `viewers` are additive, so the document's number equals the sum over
 *   its links. A viewer is counted **once per link**: the same browser opening two links is two
 *   link-recipients, because the per-link table sits under the "All links" tiles and readers add
 *   the column up (see `LINK_VIEWER_KEY_EXPR`). `pagesViewed` is the one exception — a *distinct*
 *   set ("how much of the deck was reached"), so the document's figure is the union across links
 *   and is ≤ the sum of the per-link figures, never > the deck.
 *
 * Known limitation, stated so nobody reads more into the number than is there: a `ShareView` row
 * is unique per (link, browser) for life, so `totals.views` counts the (link, browser) pairs
 * *active* in the window. It is "how many recipients read this lately", not "how many times it was
 * opened". It is also not quite the viewer count beside it: `LINK_VIEWER_KEY_EXPR` keys a signed-in
 * person as `u:<userId>`, so one account on two browsers is two rows but one viewer, and `views`
 * can exceed `authenticatedViewers + anonymousViewers`. For anonymous traffic the two are equal, so
 * a surface printing both side by side is usually restating one number under two names. Neither is
 * a count of openings: that needs `ShareVisit` (one row per tab session), whose coverage only starts
 * from the visit-upsert fix and so cannot answer for historical traffic yet.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { after } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { UserModel } from "@/lib/models/User";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { analyticsTierForPlan, clampAnalyticsDays, getWorkspacePlan, limitsForPlan } from "@/lib/billing/planLimits";
import { ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { toShareLinkDTO } from "@/lib/share/links";
import {
  ACTIVITY_DAY_KEY_EXPR,
  LAST_ACTIVITY_EXPR,
  LINK_VIEWER_KEY_EXPR,
  OWNER_PREVIEW_MATCH,
  RECIPIENT_ONLY_MATCH,
  activityInWindowExpr,
  activityWindowMatch,
  pageTimeMergeExpr,
  windowStartUtc,
} from "@/lib/analytics/shareViewAggregates";

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
 * Sum the `pageTimeMsByPage` maps pushed by the viewer `$group` into one object.
 *
 * Built from the `$group` output field directly — see `pageTimeMergeExpr`, which documents why
 * referencing a sibling alias of the same `$project` silently produced `{}` for every viewer.
 */
const MERGE_PAGE_TIME_OBJECTS = pageTimeMergeExpr("pageTimeMaps");
type ScopeTotals = { views: number; pagesViewed: number; lastSeen: Date | null };

/**
 * Views and distinct pages for one scope. The caller supplies the `$match` — `{ shareId }` for a
 * link, `{ docId }` for the document, either of them optionally bounded by `createdDate` — so the
 * two scopes are the same arithmetic on different rows and cannot disagree about what a number means.
 */
async function totalsForMatch(match: Record<string, unknown>): Promise<ScopeTotals> {
  const rows = (await ShareViewModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        views: { $sum: 1 },
        // Real view activity only — never `updatedDate`, which any maintenance write stamps.
        lastSeen: { $max: LAST_ACTIVITY_EXPR },
        pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
      },
    },
    {
      $project: {
        _id: 0,
        views: 1,
        lastSeen: 1,
        pagesViewed: {
          $size: { $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
        },
      },
    },
  ])) as Array<{ views?: number; pagesViewed?: number; lastSeen?: Date | null }>;
  const row = rows[0];
  return {
    views: typeof row?.views === "number" && Number.isFinite(row.views) ? row.views : 0,
    pagesViewed: typeof row?.pagesViewed === "number" && Number.isFinite(row.pagesViewed) ? row.pagesViewed : 0,
    lastSeen: row?.lastSeen ? new Date(row.lastSeen) : null,
  };
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

      const requestedDays = Math.min(60, asPositiveInt(url.searchParams.get("days")) ?? 15);
      /** `?byLink=1` adds the same window broken down per link, in the same response. */
      const wantsByLink = url.searchParams.get("byLink") === "1";
      /**
       * Bounds how many rows `byLink` can return, so a document with hundreds of links cannot make
       * this response (or a card slicing it down to three) proportional to the link count. Exactly
       * one of the two is meant to be set by a caller:
       * - `topLinks=<n>`: rank, don't list — the top `n` by views and the top `n` by recency,
       *   deduped (at most `2n` rows). For a card that only ever shows a handful of names.
       * - `shareIds=<a,b,c>`: exactly those links, nothing else. For a paginated table that already
       *   knows which links are on the visible page and wants their numbers, not everyone else's.
       * Neither set falls back to every link that ever had traffic on the document — kept only for
       * a caller that has already paged or ranked upstream; every current caller sets one of these.
       */
      const topLinksParam = Math.min(20, asPositiveInt(url.searchParams.get("topLinks")) ?? 0);
      const shareIdsParam = (url.searchParams.get("shareIds") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
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
      //
      // One hit on the unique `shareId_1` index, with `docId` keeping the ownership check. This
      // used to go through `listShareLinks`, which lists every link of the document *and* runs
      // `ensureDefaultLink` — i.e. a read-only analytics GET could create a share link and update
      // the document as a side effect, twelve times over on a twelve-link metrics page.
      const link = shareIdFilter
        ? await ShareLinkModel.findOne({ shareId: shareIdFilter, docId: docObjectId }).lean<ShareLink>()
        : null;
      if (shareIdFilter && !link) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }
      /**
       * What every `ShareView` aggregate matches on: one link, or the whole document — and never
       * the owner's own opens (`RECIPIENT_ONLY_MATCH`), on any figure, on either scope.
       */
      const scopeMatch: Record<string, unknown> = {
        ...(link ? { shareId: link.shareId } : { docId: docObjectId }),
        ...RECIPIENT_ONLY_MATCH,
      };
      /** The document scope of the per-link breakdown, which never follows `?shareId=`. */
      const docScopeMatch: Record<string, unknown> = { docId: docObjectId, ...RECIPIENT_ONLY_MATCH };

      const start = windowStartUtc(days);
      const startKey = utcDayKey(start);
      // A capability, never a gate. This is what the UI may *say* about downloads; it decides
      // nothing about what is counted. The document-level `shareAllowPdfDownload` is only a mirror
      // of the default link's setting, so reading it here reported "Off" for a document whose
      // second link was being downloaded daily — and, worse, suppressed the download aggregates
      // entirely, hiding rows that exist.
      const downloadsEnabled = link
        ? Boolean(link.allowDownload)
        : // "Live" is `isLinkActive`: enabled, not archived, **and** not expired. Checking only
          // `archivedAt` reported "PDF downloads enabled" for a document whose one
          // download-allowing link had been switched off or had expired.
          Boolean(
            await ShareLinkModel.exists({
              docId: docObjectId,
              archivedAt: null,
              enabled: true,
              allowDownload: true,
              $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
            }),
          ) ||
          Boolean((doc as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload);

      // Totals for the window, and the lifetime figures beside them. Both scopes run the same
      // aggregation over `scopeMatch`, so "All links" is the sum of its links by construction.
      // The owner-side rows this response is deliberately not counting. Same scope, opposite
      // flag, so a reader can see that the exclusion happened and how large it was.
      const ownerScopeMatch: Record<string, unknown> = {
        ...(link ? { shareId: link.shareId } : { docId: docObjectId }),
        ...OWNER_PREVIEW_MATCH,
      };
      const [windowTotals, allTimeTotals, windowOwnerPreviews, allTimeOwnerPreviews] = await Promise.all([
        totalsForMatch({ ...scopeMatch, ...activityWindowMatch(start) }),
        totalsForMatch(scopeMatch),
        ShareViewModel.countDocuments({ ...ownerScopeMatch, ...activityWindowMatch(start) }),
        ShareViewModel.countDocuments(ownerScopeMatch),
      ]);

      // `opens`: how many times the document was actually opened, one per tab session
      // (`ShareVisit`). This is the only figure here that counts *events* rather than recipients —
      // `views` counts (link, browser) pairs, so a reader who came back three times is one view
      // and three opens, and the difference between those two numbers is the whole signal of a
      // returning reader. Bounded by `lastEventAt`, the same "active in the window" rule the rest
      // of the response uses.
      //
      // Coverage note, because a number that silently under-reports is worse than none: visit rows
      // only exist from the visit-upsert fix onwards. Traffic older than that has views and no
      // opens, so `opens < views` on historical data is missing rows, not a quiet document.
      const visitMatch: Record<string, unknown> = { ...scopeMatch, ...RECIPIENT_ONLY_MATCH };
      const [windowOpens, allTimeOpens] = await Promise.all([
        ShareVisitModel.countDocuments({ ...visitMatch, lastEventAt: { $gte: start } }),
        ShareVisitModel.countDocuments(visitMatch),
      ]);

      // The counters are a floor for a document whose rows were swept by a cleanup script; they
      // are never allowed to *replace* the row count, which is the only recomputable number.
      //
      // Document scope only. `Doc.numberOfViews` is the sum over every link, so applying it in the
      // filtered branch reported the whole document's lifetime traffic as the traffic of one link
      // — a link nobody had ever opened answered `totalsAllTime.views: 20`.
      const legacyViews = link ? 0 : typeof (doc as any).numberOfViews === "number" ? (doc as any).numberOfViews : 0;
      const allTimeViews = allTimeTotals.views > 0 ? allTimeTotals.views : legacyViews;
      const totalViews = windowTotals.views;
      const pagesViewed = windowTotals.pagesViewed;

      // `?viewersOnly=1` skips the series and the download aggregates for latency — it is the
      // second request the metrics page fires, and it only wants viewer rows. What it must not do
      // is report the figures it never computed: it answered `totals.downloads: 0` and `series: []`
      // beside a first response that said 3, so the same field of the same endpoint contradicted
      // itself depending on a query param. Fields this branch did not compute are now absent from
      // the response, which a reader can detect; a zero is indistinguishable from the truth.
      const series: Array<{ date: string; views: number; opens: number; downloads: number }> = [];
      let totalDownloads = 0;
      let allTimeDownloads = 0;
      if (!viewersOnly) {
        const [seriesAgg, downloadsSeriesAgg, downloadsAgg, opensSeriesAgg] = await Promise.all([
          ShareViewModel.aggregate([
            { $match: { ...scopeMatch, ...activityWindowMatch(start) } },
            {
              // Bucketed by last activity, like the window itself — so the bars still add up to
              // `totals.views`, and a reader who came back shows on the day they came back.
              $group: { _id: ACTIVITY_DAY_KEY_EXPR, views: { $sum: 1 } },
            },
            { $sort: { _id: 1 } },
          ]) as Promise<Array<{ _id: string; views: number }>>,
          // Always run, whatever the settings flag says: a download that happened is a fact, and
          // turning a link's download toggle off later must not retroactively erase it.
          ShareViewModel.aggregate([
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
          ]) as Promise<Array<{ _id: string; downloads: number }>>,
          ShareViewModel.aggregate([
            { $match: { ...scopeMatch } },
            { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
          ]) as Promise<Array<{ downloads?: number }>>,
          // Opens per day: the same visits `totals.opens` counts (recipient tab sessions active in
          // the window), bucketed by their last activity, so the bars add up to the Opens figure.
          ShareVisitModel.aggregate([
            { $match: { ...visitMatch, lastEventAt: { $gte: start } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$lastEventAt", timezone: "UTC" } }, opens: { $sum: 1 } } },
          ]) as Promise<Array<{ _id: string; opens: number }>>,
        ]);

        const byDay = new Map<string, number>(seriesAgg.map((x) => [x._id, x.views]));
        const downloadsByDay = new Map<string, number>(downloadsSeriesAgg.map((x) => [x._id, x.downloads]));
        const opensByDay = new Map<string, number>(opensSeriesAgg.map((x) => [x._id, x.opens]));
        for (let i = 0; i < days; i++) {
          const d = new Date(start);
          d.setUTCDate(start.getUTCDate() + i);
          const key = utcDayKey(d);
          series.push({ date: key, views: byDay.get(key) ?? 0, opens: opensByDay.get(key) ?? 0, downloads: downloadsByDay.get(key) ?? 0 });
        }

        // The windowed total is the area under the chart, by construction: same rows, same bound.
        totalDownloads = downloadsSeriesAgg.reduce(
          (acc, x) => acc + (typeof x.downloads === "number" && Number.isFinite(x.downloads) ? x.downloads : 0),
          0,
        );
        allTimeDownloads =
          downloadsAgg && downloadsAgg[0] && typeof downloadsAgg[0].downloads === "number" ? downloadsAgg[0].downloads : 0;
      }

      // The same window, grouped by link. One aggregation instead of one request per link, and —
      // because it is the same pipeline as `totals` with a `$group` on `$shareId` — the rows add up
      // to the header by construction, archived links included (their rows are in the document
      // scope even though the link no longer resolves).
      //
      // Always the whole document, whatever `?shareId=` says: this breakdown exists to compare the
      // links with each other, and a filtered page still renders the full table under its cards.
      // So `sum(byLink) === totals` holds exactly when no link filter is applied.
      type ByLinkRow = {
        shareId: string;
        views: number;
        viewers: number;
        /** Tab sessions on this link in the window; see `totals.opens`. */
        opens: number;
        downloads: number;
        pagesViewed: number;
        lastViewedAt: string | null;
        /** Only present for a `topLinks` request — resolved from `ShareLink`, private-to-sender text. */
        label?: string | null;
        isDefault?: boolean;
      };
      /** The per-shareId grouping stage shared by every mode below; only the `$match` narrows. */
      const perLinkGroupStages = [
        {
          // One bucket per (link, viewer identity): the inner group is what makes `viewers`
          // a count of people rather than of rows. The document-scope `windowAgg` below
          // groups on the same key, which is what makes `sum(byLink[].viewers)` equal the
          // document's `viewerCount` instead of undercounting it by the shared browsers.
          $group: {
            _id: LINK_VIEWER_KEY_EXPR,
            // Same bound as the header figures: last activity, not first sighting.
            views: { $sum: { $cond: [activityInWindowExpr(start), 1, 0] } },
            lastSeen: { $max: LAST_ACTIVITY_EXPR },
            pagesSeenArrays: {
              $push: { $cond: [activityInWindowExpr(start), { $ifNull: ["$pagesSeen", []] }, []] },
            },
          },
        },
        {
          $group: {
            _id: "$_id.shareId",
            views: { $sum: "$views" },
            viewers: { $sum: { $cond: [{ $gt: ["$views", 0] }, 1, 0] } },
            lastSeen: { $max: "$lastSeen" },
            pagesSeenArrays: {
              $push: { $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
            },
          },
        },
        {
          $project: {
            _id: 0,
            shareId: "$_id",
            views: 1,
            viewers: 1,
            lastSeen: 1,
            pagesViewed: {
              $size: { $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
            },
          },
        },
      ];
      type PerLinkRow = { shareId: string; views: number; viewers: number; pagesViewed: number; lastSeen?: Date | null };
      let byLink: ByLinkRow[] | null = null;
      let linksTotal: number | null = null;
      let deletedLinkResidual: { count: number; viewers: number; downloads: number } | null = null;
      if (wantsByLink) {
        let perLinkAgg: PerLinkRow[];
        if (topLinksParam > 0) {
          // Rank first, over every link that ever had traffic, but bring back only the row itself
          // — Mongo does the ranking, so what reaches Node (and then the browser) is at most `2n`
          // rows regardless of whether the document has 3 links or 3,000.
          const [facet] = (await ShareViewModel.aggregate([
            { $match: docScopeMatch },
            ...perLinkGroupStages,
            {
              $facet: {
                byViews: [{ $sort: { views: -1 } }, { $limit: topLinksParam }],
                byRecent: [{ $sort: { lastSeen: -1 } }, { $limit: topLinksParam }],
              },
            },
          ])) as Array<{ byViews: PerLinkRow[]; byRecent: PerLinkRow[] }>;
          const dedup = new Map<string, PerLinkRow>();
          for (const r of [...(facet?.byViews ?? []), ...(facet?.byRecent ?? [])]) dedup.set(r.shareId, r);
          perLinkAgg = [...dedup.values()];
        } else {
          // Matched all-time so every slug that ever had traffic gets a row (and a real
          // `lastViewedAt`); the window is applied inside the accumulators, so the counts still
          // cover `days`. Narrowed to `shareIdsParam` when the caller already knows which links it
          // wants (a paginated table asking only about the links on its current page).
          const linkMatch = shareIdsParam.length ? { ...docScopeMatch, shareId: { $in: shareIdsParam } } : docScopeMatch;
          perLinkAgg = (await ShareViewModel.aggregate([{ $match: linkMatch }, ...perLinkGroupStages])) as PerLinkRow[];
        }

        // Downloads and opens only for the shareIds the ranking (or the caller) actually kept —
        // the same bound, carried through the two joins that used to run over every link. `null`
        // (legacy, neither `topLinks` nor `shareIds` given) means "every link", exactly as before.
        const keptShareIds = perLinkAgg.map((r) => r.shareId).filter(Boolean);
        const bounded = topLinksParam > 0 || shareIdsParam.length > 0;
        const boundedShareIdMatch: Record<string, unknown> = bounded ? { shareId: { $in: keptShareIds } } : {};
        const skipJoins = bounded && keptShareIds.length === 0;
        const [perLinkDownloadsAgg, perLinkOpensAgg, linkMeta] = await Promise.all([
          skipJoins
            ? Promise.resolve([])
            : (ShareViewModel.aggregate([
                { $match: { ...docScopeMatch, ...boundedShareIdMatch } },
                { $project: { shareId: 1, items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
                { $unwind: "$items" },
                { $match: { "items.k": { $gte: startKey } } },
                { $group: { _id: "$shareId", downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
              ]) as Promise<Array<{ _id: string; downloads: number }>>),
          skipJoins
            ? Promise.resolve([])
            : (ShareVisitModel.aggregate([
                { $match: { docId: docObjectId, ...RECIPIENT_ONLY_MATCH, lastEventAt: { $gte: start }, ...boundedShareIdMatch } },
                { $group: { _id: "$shareId", opens: { $sum: 1 } } },
              ]) as Promise<Array<{ _id: string; opens: number }>>),
          // Labels are private-to-sender text the client can't otherwise resolve from an aggregate;
          // `topLinks` mode attaches them here so a caller ranking by traffic never has to fetch
          // every link just to name the handful it is about to show. Bounded to the same rows.
          topLinksParam > 0 && keptShareIds.length
            ? ShareLinkModel.find({ docId: docObjectId, shareId: { $in: keptShareIds } })
                .select({ shareId: 1, label: 1, isDefault: 1 })
                .lean<Array<{ shareId: string; label?: string; isDefault?: boolean }>>()
            : Promise.resolve([]),
        ]);
        const opensBySlug = new Map<string, number>(perLinkOpensAgg.map((r) => [r._id, r.opens]));
        const downloadsBySlug = new Map<string, number>(perLinkDownloadsAgg.map((r) => [r._id, r.downloads]));
        const metaBySlug = new Map(linkMeta.map((l) => [l.shareId, l]));
        // Live links only, so "all N links" in a card names what a person could actually go look
        // at — an archived link's traffic still counts in `byLink`/`totals` above, it just does not
        // add to this number, the same split `GET /api/docs/:docId/links` already draws.
        linksTotal = await ShareLinkModel.countDocuments({ docId: docObjectId, archivedAt: null });

        // Traffic this response's `byLink` cannot otherwise explain: a slug that has views but no
        // live link owns it (its link was archived after the fact). `DocLinksManager`'s page table
        // used to detect this by diffing the *whole* unbounded `byLink` against its links list —
        // exactly the unbounded shape this endpoint now refuses to hand back. So the server does
        // the diff instead and returns only the sum: one row, whatever the real orphan count is.
        // Skipped in `topLinks` mode (the quick-stats card, which never rendered this row) to keep
        // that request to the two aggregates it actually needs.
        if (topLinksParam === 0) {
          const liveShareIds = await ShareLinkModel.find({ docId: docObjectId, archivedAt: null }).distinct("shareId");
          const [orphanViewersAgg, orphanDownloadsAgg] = await Promise.all([
            ShareViewModel.aggregate([
              { $match: { ...docScopeMatch, shareId: { $nin: liveShareIds } } },
              { $group: { _id: LINK_VIEWER_KEY_EXPR, views: { $sum: { $cond: [activityInWindowExpr(start), 1, 0] } } } },
              { $group: { _id: null, viewers: { $sum: { $cond: [{ $gt: ["$views", 0] }, 1, 0] } }, shareIds: { $addToSet: "$_id.shareId" } } },
              { $project: { _id: 0, viewers: 1, count: { $size: "$shareIds" } } },
            ]) as Promise<Array<{ viewers: number; count: number }>>,
            ShareViewModel.aggregate([
              { $match: { ...docScopeMatch, shareId: { $nin: liveShareIds } } },
              { $project: { items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
              { $unwind: "$items" },
              { $match: { "items.k": { $gte: startKey } } },
              { $group: { _id: null, downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
            ]) as Promise<Array<{ downloads: number }>>,
          ]);
          const orphanCount = orphanViewersAgg[0]?.count ?? 0;
          const orphanViewers = orphanViewersAgg[0]?.viewers ?? 0;
          const orphanDownloads = orphanDownloadsAgg[0]?.downloads ?? 0;
          deletedLinkResidual =
            orphanCount > 0 && (orphanViewers > 0 || orphanDownloads > 0)
              ? { count: orphanCount, viewers: orphanViewers, downloads: orphanDownloads }
              : null;
        }
        byLink = perLinkAgg
          .map((r) => ({
            shareId: typeof r.shareId === "string" ? r.shareId : "",
            views: typeof r.views === "number" ? r.views : 0,
            viewers: typeof r.viewers === "number" ? r.viewers : 0,
            opens: opensBySlug.get(r.shareId) ?? 0,
            downloads: downloadsBySlug.get(r.shareId) ?? 0,
            ...(topLinksParam > 0
              ? { label: metaBySlug.get(r.shareId)?.label ?? null, isDefault: Boolean(metaBySlug.get(r.shareId)?.isDefault) }
              : {}),
            pagesViewed: typeof r.pagesViewed === "number" ? r.pagesViewed : 0,
            lastViewedAt: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
          }))
          .filter((r) => Boolean(r.shareId))
          .sort((a, b) => b.views - a.views);
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
      //
      // The bucket is (link, viewer), not viewer: a person who opened two links of this document
      // is two link-recipients. That is the choice that keeps the document figure equal to the sum
      // of the `byLink` rows rendered directly beneath it — grouping by person alone made the card
      // say "3 people" over a table whose Viewers column added up to 4, with nothing on the page
      // to reconcile them.
      const windowAgg = (await ShareViewModel.aggregate([
        { $match: { ...scopeMatch, ...activityWindowMatch(start) } },
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
            timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } },
          },
        },
        { $group: { _id: "$_id.viewer.kind", viewers: { $sum: 1 }, timeSpentMs: { $sum: "$timeSpentMs" } } },
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

      // Both tiers report the *window* counts, on every tier and whether or not viewer rows were
      // asked for. They used to come from `viewersAgg.length` / `anonymousAgg.length` on Pro —
      // lifetime aggregates with no date bound and a `$limit: 100` — so a `totals` object
      // documented as covering `days` rendered "2 views · 0 authenticated viewers · 18 anonymous
      // viewers" on one line of the Views card, and stopped growing past a hundred viewers.
      // `viewerCount === authenticatedViewers + anonymousViewers` now holds by construction.
      const uniqueAuthedViewers = windowAuthedViewers;
      const uniqueAnonymousViewers = windowAnonymousViewers;

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
              // `timestamps: false`: this is maintenance, not a view. Mongoose stamps
              // `updatedDate` on any update query, and "Last viewed" is the `$max` over the rows,
              // so an owner opening the metrics page used to reset the whole Last-viewed column of
              // the links table to "just now" — the read path rewriting the number it reports.
              if (ops.length) await ShareViewModel.bulkWrite(ops, { ordered: false, timestamps: false });
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
        /**
         * Link-recipients (signed-in + anonymous) within the window; available on both tiers.
         * One per (link, viewer), so the document's figure is the sum of the `byLink` rows and
         * always equals `totals.authenticatedViewers + totals.anonymousViewers`.
         */
        viewerCount,
        /** Every figure here covers `days`, like `series` and `viewerCount`. No lifetime figure leaks in. */
        totals: {
          views: totalViews,
          /**
           * Owner-side opens in the window, recorded and *not* counted anywhere else in this
           * response. Reported so the negative space is visible: `views: 0, ownerPreviews: 3` is
           * "only you have opened this", not "nobody has". A floor, not a count — the flag needs
           * a signed-in session, so a logged-out owner is indistinguishable from a recipient.
           */
          ownerPreviews: windowOwnerPreviews,
          /**
           * Times the document was opened in the window, one per tab session. The only count of
           * events here: `views` counts recipients, so a reader who returned three times is one
           * view and three opens. `0` on traffic older than the visit-upsert fix, which wrote none.
           */
          opens: windowOpens,
          /**
           * True when `opens` is known to be missing rows, so a reader can withhold it instead of
           * printing something impossible.
           *
           * Every viewer had at least one sitting, so `opens` can never honestly be below `views`.
           * When it is, the visit rows for that traffic were never written — it predates the
           * visit-upsert fix — and the figure is a floor, not a count. Deriving this in each UI
           * would be three copies of one rule; the server knows, so the server says.
           */
          opensPartial: windowOpens < totalViews,
          // Absent, not zero, when `?viewersOnly=1` skipped the aggregate that produces it.
          ...(viewersOnly ? {} : { downloads: totalDownloads }),
          pagesViewed,
          /** Total time on the document within the window (ms), summed across all viewers. */
          timeSpentMs: Math.max(0, Math.floor(windowTimeSpentMs)),
          authenticatedViewers: uniqueAuthedViewers,
          anonymousViewers: uniqueAnonymousViewers,
        },
        /** Lifetime figures for the same scope, for cards that genuinely want "ever". */
        totalsAllTime: {
          views: allTimeViews,
          ownerPreviews: allTimeOwnerPreviews,
          opens: allTimeOpens,
          opensPartial: allTimeOpens < allTimeViews,
          ...(viewersOnly ? {} : { downloads: allTimeDownloads }),
          pagesViewed: allTimeTotals.pagesViewed,
        },
        /**
         * Most recent recorded activity in this scope, from the rows themselves. The `ShareLink`
         * row's own `lastViewedAt` only started moving when links shipped, so a link that adopted
         * a document's older traffic reported "Never" beside a non-zero view count.
         */
        lastViewedAt: allTimeTotals.lastSeen ? allTimeTotals.lastSeen.toISOString() : null,
        /**
         * `?byLink=1`: the same window, per link slug, always for the whole document (the table
         * compares links, so it does not follow `?shareId=`). Unfiltered,
         * `sum(byLink[].views) === totals.views` and `sum(byLink[].downloads) === totals.downloads`,
         * so the rows reconcile with the "All links" figures above them — including slugs whose
         * link has since been archived, which `GET /api/docs/:docId/links` does not return.
         */
        ...(byLink ? { byLink } : {}),
        /**
         * Count of live (unarchived) links, alongside a `byLink` that may only cover a handful of
         * them (`topLinks`) or a specific page (`shareIds`). A card that only fetched the top few
         * still needs to say "all 40 links" without ever listing them.
         */
        ...(linksTotal !== null ? { linksTotal } : {}),
        ...(topLinksParam === 0 && wantsByLink ? { deletedLinkResidual } : {}),
        /**
         * The resolved link itself, only when `?shareId=` named one. The metrics page used to
         * resolve a link's label (and had no way to show its settings at all) from a separate,
         * unpaginated `GET /api/docs/:docId/links` fetch — which broke the moment the link a reader
         * was looking at was not on that list's first page. This is the same row `link` already is,
         * for free, in the DTO shape every other link surface uses.
         */
        ...(link ? { link: toShareLinkDTO(link) } : {}),
        /**
         * Whether downloads are *allowed* (this link, or any live link of the document) — a label,
         * not a filter: the download numbers above are counted either way.
         */
        downloadsEnabled,
        ...(viewersOnly ? {} : { series }),
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


