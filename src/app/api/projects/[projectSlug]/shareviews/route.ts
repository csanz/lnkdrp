/**
 * Owner project share-view metrics API.
 * Route: `/api/projects/:projectId/shareviews`
 *
 * The project-shaped twin of `/api/docs/:docId/shareviews`, and deliberately the **same response
 * envelope** — `days`, `totals`, `totalsAllTime`, `series`, `byLink`, `linksTotal`,
 * `deletedLinkResidual`, `link`, `viewers`, `anonymousViewers` — because `MetricsView`
 * (`src/components/metrics/MetricsView.tsx`) renders both surfaces from one component and can only
 * do that if the two endpoints speak the same language.
 *
 * Why a sibling route rather than a `scope` parameter on the document one: that file is 979 lines
 * of document vocabulary whose every aggregate is bounded by `{ docId }`, and its per-page figures
 * (`pagesSeen`, `pageTimeMsByPage`) answer a question a project does not have — a project link
 * spans many documents, so "pages viewed" is not a fact about it. The genuinely shared pieces (the
 * window rules, the recipient-only match, the viewer-key expression, the day bucketing) are
 * imported from `src/lib/analytics/shareViewAggregates.ts` rather than copied, so the two cannot
 * drift on what "active in the window" or "a viewer" means.
 *
 * What replaces the per-page figures: `totals.docsOpened`, the number of distinct documents
 * recipients actually opened through the project's links. It is the project-scale equivalent of
 * "how much of the deck was reached".
 *
 * Two figures here have no document counterpart at all, and both come from
 * `src/lib/analytics/project/pipelines.ts` (milestone M4):
 * - `totals.landings` / `totals.landedWithoutOpening` — a project link has a landing page, so
 *   arriving and opening are different events and someone can do the first without the second.
 *   `ShareView` never hears about that person; `ProjectLinkView` is the only record they exist.
 * - `byDoc` / `docsTotal` (`?byDoc=1&topDocs=n`) — which documents recipients opened, ranked. This
 *   one *does* follow `?shareId=`, unlike `byLink`: "which files did this recipient group open" is
 *   precisely the per-link question, where ranking the link the page is about against its siblings
 *   is not.
 *
 * Scope rules, identical to the document route:
 * - Without `?shareId=`, every figure covers the project — *all* of its links, archived ones
 *   included, because a deleted link's traffic stays in the project's totals by design.
 * - With `?shareId=<slug>`, the same response is scoped to that one link. An unknown slug, or one
 *   belonging to another project, is a 404 — never a silent whole-project read.
 * - `byLink` and `linksTotal` never follow `?shareId=`: they exist to compare the links with each
 *   other, so a filtered page still renders the full ranking beneath its cards.
 * - The owner's own opens are recorded and excluded everywhere (`RECIPIENT_ONLY_MATCH`), and
 *   reported as `totals.ownerPreviews` so the exclusion is visible.
 */
import { NextResponse } from "next/server";
import type { PipelineStage } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { PROJECT_LINK_FILTER, ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { analyticsTierForPlan, clampAnalyticsDays, getWorkspacePlan, limitsForPlan } from "@/lib/billing/planLimits";
import { projectShareIds, toProjectLinkDTO } from "@/lib/share/projectLinks";
import {
  LAST_ACTIVITY_EXPR,
  intersectShareIds,
  shareIdClause,
  OWNER_PREVIEW_MATCH,
  RECIPIENT_ONLY_MATCH,
  activityInWindowExpr,
  activityWindowMatch,
  windowStartUtc,
} from "@/lib/analytics/shareViewAggregates";
import { PROJECT_ANON_KEY_EXPR, PROJECT_LINK_VIEWER_KEY_EXPR } from "@/lib/analytics/project/viewerKey";
import {
  byDocPipeline,
  landingsPipeline,
  readLandingRollup,
  shapeByDoc,
  viewsByDayPipeline,
  type RawByDocRow,
  type RawLandingRollup,
} from "@/lib/analytics/project/pipelines";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { DocModel } from "@/lib/models/Doc";
import { accessProjectForLinks, linkErrorResponse } from "../links/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function n0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

type ScopeTotals = { views: number; docsOpened: number; lastSeen: Date | null };

/**
 * Views and distinct documents for one scope. The caller supplies the `$match`, so every scope on
 * this route is the same arithmetic over different rows and they cannot disagree about what a
 * number means.
 *
 * `views` counts **(link, viewer) pairs**, not rows — the two-stage group is the whole point. On a
 * document link a `ShareView` row already *is* one (link, viewer) pair, which is why the document
 * route can count rows and why its links table prints no separate Views column. On a project link a
 * row is one (link, viewer, **document**) triple (docs/METRICS.md, "Project links: how a data-room
 * visit is keyed"), so counting rows reported a data room with two documents as twice the traffic
 * it had. Grouping first keeps both routes reporting the same quantity under the same name.
 */
async function totalsForMatch(match: Record<string, unknown>): Promise<ScopeTotals> {
  const rows = (await ShareViewModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: PROJECT_LINK_VIEWER_KEY_EXPR,
        // Real view activity only — never `updatedDate`, which any maintenance write stamps.
        lastSeen: { $max: LAST_ACTIVITY_EXPR },
        docIds: { $addToSet: "$docId" },
      },
    },
    { $group: { _id: null, views: { $sum: 1 }, lastSeen: { $max: "$lastSeen" }, docIdSets: { $push: "$docIds" } } },
    {
      $project: {
        _id: 0,
        views: 1,
        lastSeen: 1,
        docsOpened: {
          $size: { $reduce: { input: "$docIdSets", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
        },
      },
    },
  ])) as Array<{ views?: number; docsOpened?: number; lastSeen?: Date | null }>;
  const row = rows[0];
  return { views: n0(row?.views), docsOpened: n0(row?.docsOpened), lastSeen: row?.lastSeen ? new Date(row.lastSeen) : null };
}

/**
 * `GET /api/projects/:projectId/shareviews`
 *
 * Query: `days` (clamped by plan), `shareId` (scope to one link), `byLink=1`, `topLinks=<n>` |
 * `shareIds=<a,b,c>` (bound the breakdown), `viewers=1`, `viewersOnly=1`.
 * Readable by any member of the workspace — reading a project's own traffic is not an edit.
 */
export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId, name } = gate.access;
  try {
    const url = new URL(request.url);
    const requestedDays = Math.min(365, asPositiveInt(url.searchParams.get("days")) ?? 15);
    const wantsByLink = url.searchParams.get("byLink") === "1";
    const topLinksParam = Math.min(20, asPositiveInt(url.searchParams.get("topLinks")) ?? 0);
    /** The project's own ranking: which documents recipients opened. No document analogue. */
    const wantsByDoc = url.searchParams.get("byDoc") === "1";
    const topDocsParam = Math.min(50, asPositiveInt(url.searchParams.get("topDocs")) ?? 5);
    const shareIdsParam = (url.searchParams.get("shareIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    const wantsViewers = url.searchParams.get("viewers") === "1";
    const viewersOnly = url.searchParams.get("viewersOnly") === "1";

    await connectMongo();

    const plan = await getWorkspacePlan(String(orgId));
    const days = clampAnalyticsDays(plan, requestedDays);
    const analyticsDaysLimit = limitsForPlan(plan).analyticsDays;
    const analyticsTier = analyticsTierForPlan(plan);
    const includeViewers = analyticsTier === "deep" && wantsViewers;

    // Read-only, deliberately: this listed every link of the project purely so that
    // `ensureDefaultProjectLink` would run inside it, i.e. a metrics GET could create a `ShareLink`
    // and rewrite `Project.shareId`, and it did it on top of the `projectShareIds` read below that
    // already answers the only question this route asks of the links. A project that predates the
    // link model has its default materialised on the project page load and on the first public
    // visit to `/p/:shareId`; until then it has no traffic to report anyway.
    const { live: liveShareIds, all: allShareIds } = await projectShareIds({ orgId, projectId });

    // `?shareId=` scopes every aggregate to one link of *this* project. A slug from another
    // project (or a document link) is a 404, never a silent whole-project read.
    const link = shareIdFilter
      ? await ShareLinkModel.findOne({ shareId: shareIdFilter, projectId, ...PROJECT_LINK_FILTER }).lean<ShareLink>()
      : null;
    if (shareIdFilter && !link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    /** One link, or every slug this project ever owned — and never the owner's own opens. */
    const scopeMatch: Record<string, unknown> = {
      shareId: link ? link.shareId : { $in: allShareIds },
      ...RECIPIENT_ONLY_MATCH,
    };
    /** The project scope of the per-link breakdown, which never follows `?shareId=`. */
    const projectScopeMatch: Record<string, unknown> = { shareId: { $in: allShareIds }, ...RECIPIENT_ONLY_MATCH };
    const ownerScopeMatch: Record<string, unknown> = {
      shareId: link ? link.shareId : { $in: allShareIds },
      ...OWNER_PREVIEW_MATCH,
    };

    const start = windowStartUtc(days);
    const startKey = utcDayKey(start);

    // A capability, never a gate: this is what the UI may *say* about downloads, and it decides
    // nothing about what is counted. "Live" is enabled ∧ unarchived ∧ unexpired, so a project whose
    // one download-allowing link has expired does not claim downloads are on.
    const downloadsEnabled = link
      ? Boolean(link.allowDownload)
      : Boolean(
          await ShareLinkModel.exists({
            projectId,
            ...PROJECT_LINK_FILTER,
            archivedAt: null,
            enabled: true,
            allowDownload: true,
            $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
          }),
        );

    const [windowTotals, allTimeTotals, windowOwnerPreviews, allTimeOwnerPreviews] = await Promise.all([
      totalsForMatch({ ...scopeMatch, ...activityWindowMatch(start) }),
      totalsForMatch(scopeMatch),
      ShareViewModel.countDocuments({ ...ownerScopeMatch, ...activityWindowMatch(start) }),
      ShareViewModel.countDocuments(ownerScopeMatch),
    ]);

    // `opens`: tab sessions (`ShareVisit`), the one figure here that counts events rather than
    // recipients. `0` for traffic older than the visit-upsert fix, which wrote no visit rows.
    //
    // Counted as **distinct tab sessions**, not rows. `visitId` is stored per `shareId`, and a
    // project link is one `shareId` for the whole data room, so one tab that reads two documents
    // writes two `ShareVisit` rows sharing a `visitIdHash` — one session, one row per document in
    // it (docs/METRICS.md). `countDocuments` would have called that two opens.
    const visitMatch: Record<string, unknown> = { ...scopeMatch };
    const countSessions = async (match: Record<string, unknown>): Promise<number> => {
      const rows = (await ShareVisitModel.aggregate([
        { $match: match },
        { $group: { _id: { shareId: "$shareId", visit: "$visitIdHash" } } },
        { $count: "n" },
      ])) as Array<{ n?: number }>;
      return n0(rows[0]?.n);
    };
    const [windowOpens, allTimeOpens, visitTimeAgg] = await Promise.all([
      countSessions({ ...visitMatch, lastEventAt: { $gte: start } }),
      countSessions(visitMatch),
      ShareVisitModel.aggregate([
        { $match: { ...visitMatch, lastEventAt: { $gte: start } } },
        { $group: { _id: null, ms: { $sum: { $ifNull: ["$timeSpentMs", 0] } } } },
      ]) as Promise<Array<{ ms?: number }>>,
    ]);
    const visitTimeMs = n0(visitTimeAgg[0]?.ms);

    // The two project-only aggregates (`src/lib/analytics/project/pipelines.ts`): who arrived on
    // `/p/:shareId` without opening anything, and which documents the ones who did open went to.
    // Both are skipped on a `viewersOnly=1` follow-up, which exists precisely to avoid re-running
    // the figures the first response already delivered.
    const landingScope: Record<string, unknown> = {
      shareId: link ? link.shareId : { $in: allShareIds },
      ...RECIPIENT_ONLY_MATCH,
    };
    const [landingRows, byDocRows] = viewersOnly
      ? [[], []]
      : await Promise.all([
          ProjectLinkViewModel.aggregate(landingsPipeline(landingScope, start)) as Promise<RawLandingRollup[]>,
          wantsByDoc
            ? (ShareViewModel.aggregate(byDocPipeline(scopeMatch, start, topDocsParam)) as Promise<RawByDocRow[]>)
            : Promise.resolve([] as RawByDocRow[]),
        ]);
    const landings = readLandingRollup(landingRows);

    let byDoc: ReturnType<typeof shapeByDoc> | null = null;
    let docsTotal: number | null = null;
    if (wantsByDoc && !viewersOnly) {
      const docIds = byDocRows.map((r) => r.docId).filter(Boolean);
      const [docMeta, liveDocs] = await Promise.all([
        docIds.length
          ? DocModel.find({ _id: { $in: docIds } })
              .select({ _id: 1, title: 1, fileName: 1 })
              .lean<Array<{ _id: unknown; title?: string; fileName?: string }>>()
          : Promise.resolve([]),
        // Membership is `projectIds[]` on new docs and a bare `projectId` on ones written before
        // a doc could belong to several projects — the same `$or` the project's own list route uses.
        // `shareEnabled: { $ne: false }` because this number is the denominator of "N of them
        // opened", and the recipient can only ever open what `/p/:shareId` lists — see
        // `projectDocFilter` in `src/lib/share/projectPublic.ts`, whose filter this mirrors. Without
        // it a data room with ten documents, seven of them not shared, told its owner nobody had
        // opened seven files that were never on offer.
        DocModel.countDocuments({
          $or: [{ projectId }, { projectIds: projectId }],
          isDeleted: { $ne: true },
          isArchived: { $ne: true },
          shareEnabled: { $ne: false },
        }),
      ]);
      const titles = new Map<string, string>();
      for (const d of docMeta) {
        // `fileName` is the fallback a document list uses when a doc was never given a title; an
        // untitled *and* unnamed row keeps no entry, and `shapeByDoc` renders it as a deleted one.
        const t = (d.title ?? d.fileName ?? "").trim();
        if (t) titles.set(String(d._id), t);
      }
      byDoc = shapeByDoc(byDocRows, titles);
      docsTotal = liveDocs;
    }

    const series: Array<{ date: string; views: number; opens: number; downloads: number }> = [];
    let totalDownloads = 0;
    let allTimeDownloads = 0;
    if (!viewersOnly) {
      const [seriesAgg, downloadsSeriesAgg, downloadsAgg, opensSeriesAgg] = await Promise.all([
        // `viewsByDayPipeline` — the two-stage bucket that keeps the area under the chart equal to
        // `totals.views`; see that function for why the viewer bucket has to close before the day
        // bucket opens on a project link.
        ShareViewModel.aggregate(viewsByDayPipeline(scopeMatch, start)) as Promise<Array<{ _id: string; views: number }>>,
        // Always run, whatever the settings flag says: a download that happened is a fact, and
        // turning a link's download toggle off later must not retroactively erase it.
        ShareViewModel.aggregate([
          { $match: { ...scopeMatch } },
          { $project: { items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
          { $unwind: "$items" },
          { $match: { "items.k": { $gte: startKey } } },
          { $group: { _id: "$items.k", downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
          { $sort: { _id: 1 } },
        ]) as Promise<Array<{ _id: string; downloads: number }>>,
        ShareViewModel.aggregate([
          { $match: { ...scopeMatch } },
          { $group: { _id: null, downloads: { $sum: { $ifNull: ["$downloads", 0] } } } },
        ]) as Promise<Array<{ downloads?: number }>>,
        ShareVisitModel.aggregate([
          { $match: { ...visitMatch, lastEventAt: { $gte: start } } },
          {
            $group: {
              _id: {
                day: { $dateToString: { format: "%Y-%m-%d", date: "$lastEventAt", timezone: "UTC" } },
                visit: { shareId: "$shareId", visit: "$visitIdHash" },
              },
            },
          },
          { $group: { _id: "$_id.day", opens: { $sum: 1 } } },
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
      totalDownloads = downloadsSeriesAgg.reduce((acc, x) => acc + n0(x.downloads), 0);
      allTimeDownloads = n0(downloadsAgg[0]?.downloads);
    }

    type ByLinkRow = {
      shareId: string;
      views: number;
      viewers: number;
      opens: number;
      downloads: number;
      docsOpened: number;
      lastViewedAt: string | null;
      label?: string | null;
      isDefault?: boolean;
    };
    /** The per-shareId grouping shared by every mode below; only the `$match` narrows. */
    const perLinkGroupStages = [
      {
        // One bucket per (link, viewer identity): the inner group is what makes `viewers` a count
        // of people rather than of rows, and what makes `sum(byLink[].viewers)` equal the
        // project's own `viewerCount` instead of undercounting it by the shared browsers.
        $group: {
          _id: PROJECT_LINK_VIEWER_KEY_EXPR,
          views: { $sum: { $cond: [activityInWindowExpr(start), 1, 0] } },
          lastSeen: { $max: LAST_ACTIVITY_EXPR },
          docIds: { $addToSet: { $cond: [activityInWindowExpr(start), "$docId", null] } },
        },
      },
      {
        $group: {
          _id: "$_id.shareId",
          // Both are the recipient count: a bucket is one (link, viewer), so `views` means here
          // what it means on a document link, where a row already is exactly one such pair.
          views: { $sum: { $cond: [{ $gt: ["$views", 0] }, 1, 0] } },
          viewers: { $sum: { $cond: [{ $gt: ["$views", 0] }, 1, 0] } },
          lastSeen: { $max: "$lastSeen" },
          docIdSets: { $push: "$docIds" },
        },
      },
      {
        $project: {
          _id: 0,
          shareId: "$_id",
          views: 1,
          viewers: 1,
          lastSeen: 1,
          docsOpened: {
            $size: {
              $filter: {
                input: { $reduce: { input: "$docIdSets", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
                cond: { $ne: ["$$this", null] },
              },
            },
          },
        },
      },
    ];
    type PerLinkRow = { shareId: string; views: number; viewers: number; docsOpened: number; lastSeen?: Date | null };
    let byLink: ByLinkRow[] | null = null;
    let linksTotal: number | null = null;
    let deletedLinkResidual: { count: number; viewers: number; downloads: number } | null = null;
    if (wantsByLink) {
      let perLinkAgg: PerLinkRow[];
      if (topLinksParam > 0) {
        // Rank in Mongo, return at most `2n` rows, so what reaches Node stays flat however many
        // links the project has.
        const [facet] = (await ShareViewModel.aggregate([
          { $match: projectScopeMatch },
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
        // Intersect, never replace. `projectScopeMatch`'s only tenancy clause is its `shareId`
        // `$in`, and spreading a second `shareId` key silently drops it — a caller naming a slug
        // from another workspace in `shareIds` then got that link's traffic back, from a route any
        // `viewer` may call and which `LinksManager` hits on every render. Same key collision as
        // the orphan match below, opposite consequence: there it over-counted, here it leaked.
        const linkMatch = shareIdsParam.length
          ? { ...projectScopeMatch, ...shareIdClause({ only: intersectShareIds(allShareIds, shareIdsParam) }) }
          : projectScopeMatch;
        perLinkAgg = (await ShareViewModel.aggregate([{ $match: linkMatch }, ...perLinkGroupStages])) as PerLinkRow[];
      }

      const keptShareIds = perLinkAgg.map((r) => r.shareId).filter(Boolean);
      const bounded = topLinksParam > 0 || shareIdsParam.length > 0;
      // `keptShareIds` comes out of `linkMatch`/`projectScopeMatch`, so it is already a subset of
      // `allShareIds` — this replaces the project bound with a narrower one, it does not widen it.
      const boundedShareIdMatch: Record<string, unknown> = bounded ? { shareId: { $in: keptShareIds } } : {};
      const skipJoins = bounded && keptShareIds.length === 0;
      const [perLinkDownloadsAgg, perLinkOpensAgg, linkMeta] = await Promise.all([
        skipJoins
          ? Promise.resolve([])
          : (ShareViewModel.aggregate([
              { $match: { ...projectScopeMatch, ...boundedShareIdMatch } },
              { $project: { shareId: 1, items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
              { $unwind: "$items" },
              { $match: { "items.k": { $gte: startKey } } },
              { $group: { _id: "$shareId", downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
            ]) as Promise<Array<{ _id: string; downloads: number }>>),
        skipJoins
          ? Promise.resolve([])
          : (ShareVisitModel.aggregate([
              {
                $match: {
                  shareId: bounded ? { $in: keptShareIds } : { $in: allShareIds },
                  ...RECIPIENT_ONLY_MATCH,
                  lastEventAt: { $gte: start },
                },
              },
              { $group: { _id: { shareId: "$shareId", visit: "$visitIdHash" } } },
              { $group: { _id: "$_id.shareId", opens: { $sum: 1 } } },
            ]) as Promise<Array<{ _id: string; opens: number }>>),
        // Labels are private-to-sender text an aggregate cannot resolve; `topLinks` mode attaches
        // them here so a caller ranking by traffic never fetches every link just to name a handful.
        topLinksParam > 0 && keptShareIds.length
          ? ShareLinkModel.find({ projectId, ...PROJECT_LINK_FILTER, shareId: { $in: keptShareIds } })
              .select({ shareId: 1, label: 1, isDefault: 1 })
              .lean<Array<{ shareId: string; label?: string; isDefault?: boolean }>>()
          : Promise.resolve([]),
      ]);
      const opensBySlug = new Map<string, number>(perLinkOpensAgg.map((r) => [r._id, r.opens]));
      const downloadsBySlug = new Map<string, number>(perLinkDownloadsAgg.map((r) => [r._id, r.downloads]));
      const metaBySlug = new Map(linkMeta.map((l) => [l.shareId, l]));
      // Live links only, so "all N links" names what a person could actually go and open.
      linksTotal = liveShareIds.length;

      // Traffic no live link owns: a link archived after the fact keeps its rows in the project's
      // totals, and this one summary row is what explains the gap the table cannot.
      if (topLinksParam === 0) {
        // Both bounds go on **one** `shareId` clause. Spreading `projectScopeMatch` and then adding
        // a second `shareId` key silently drops the `$in`, and the aggregate then matched every
        // ShareView row in the database that did not belong to a live link of this project — the
        // table read "217 deleted links · 682 viewers" on a project with five links and five views.
        const orphanMatch = { ...projectScopeMatch, ...shareIdClause({ only: allShareIds, except: liveShareIds }) };
        const [orphanViewersAgg, orphanDownloadsAgg] = await Promise.all([
          ShareViewModel.aggregate([
            { $match: orphanMatch },
            { $group: { _id: PROJECT_LINK_VIEWER_KEY_EXPR, views: { $sum: { $cond: [activityInWindowExpr(start), 1, 0] } } } },
            { $group: { _id: null, viewers: { $sum: { $cond: [{ $gt: ["$views", 0] }, 1, 0] } }, shareIds: { $addToSet: "$_id.shareId" } } },
            { $project: { _id: 0, viewers: 1, count: { $size: "$shareIds" } } },
          ]) as Promise<Array<{ viewers: number; count: number }>>,
          ShareViewModel.aggregate([
            { $match: orphanMatch },
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
          views: n0(r.views),
          viewers: n0(r.viewers),
          opens: opensBySlug.get(r.shareId) ?? 0,
          downloads: downloadsBySlug.get(r.shareId) ?? 0,
          ...(topLinksParam > 0
            ? { label: metaBySlug.get(r.shareId)?.label ?? null, isDefault: Boolean(metaBySlug.get(r.shareId)?.isDefault) }
            : {}),
          docsOpened: n0(r.docsOpened),
          lastViewedAt: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
        }))
        .filter((r) => Boolean(r.shareId))
        .sort((a, b) => b.views - a.views);
    }

    /** Viewer rows, deep tier only. No per-page maps: a project link spans documents. */
    const viewerGroupStages = (idExpr: unknown): PipelineStage[] => [
      // Newest snapshot of the denormalized viewerName/email wins the `$first` below.
      { $sort: { updatedDate: -1 } },
      {
        $group: {
          _id: idExpr,
          firstSeen: { $min: "$createdDate" },
          lastSeen: { $max: LAST_ACTIVITY_EXPR },
          views: { $sum: 1 },
          docIds: { $addToSet: "$docId" },
          // Per-document reading time for this person, which is what the viewer drawer shows in
          // place of the per-page chart: a project link has no single page-number namespace, so
          // "which files did they read, and for how long" is the drill-down that exists here.
          docTimes: { $push: { docId: "$docId", ms: { $ifNull: ["$timeSpentMs", 0] } } },
          timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } },
          viewerName: { $first: "$viewerName" },
          viewerEmailSnapshot: { $first: "$viewerEmailSnapshot" },
        },
      },
      {
        $project: {
          _id: 0,
          key: "$_id",
          firstSeen: 1,
          lastSeen: 1,
          views: 1,
          timeSpentMs: 1,
          viewerName: 1,
          viewerEmailSnapshot: 1,
          docTimes: 1,
          docsOpened: { $size: "$docIds" },
        },
      },
      { $sort: { lastSeen: -1 } },
      { $limit: 100 },
    ];
    type RawViewer = {
      key: unknown;
      firstSeen?: Date | null;
      lastSeen?: Date | null;
      views?: number;
      timeSpentMs?: number;
      docsOpened?: number;
      docTimes?: Array<{ docId?: unknown; ms?: number }>;
      viewerName?: string | null;
      viewerEmailSnapshot?: string | null;
    };
    const [viewersAgg, anonymousAgg] = includeViewers
      ? ((await Promise.all([
          ShareViewModel.aggregate([
            { $match: { ...scopeMatch, viewerUserId: { $ne: null }, ...activityWindowMatch(start) } },
            ...viewerGroupStages("$viewerUserId"),
          ]),
          ShareViewModel.aggregate([
            {
              $match: {
                ...scopeMatch,
                // `activityWindowMatch` is itself an `$or`, so the two conditions go through `$and`.
                $and: [{ $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] }, activityWindowMatch(start)],
              },
            },
            ...viewerGroupStages(PROJECT_ANON_KEY_EXPR),
          ]),
        ])) as [RawViewer[], RawViewer[]])
      : [[], []];

    /**
     * Tab sessions per viewer — the "Sessions" tile in the viewer drawer.
     *
     * Counted as distinct `visitIdHash`, not rows: a project link is one `shareId` for the whole
     * data room, so one tab that reads two documents writes two `ShareVisit` rows sharing a visit
     * id, and counting rows would report twice the sessions. The identity is the digest prefix for
     * the same reason it is everywhere else on this route — `ShareVisit.botIdHash` carries the same
     * `<sha256>.<docId>` composite `ShareView` does.
     */
    const sessionsByViewer = new Map<string, number>();
    if (includeViewers) {
      const rows = (await ShareVisitModel.aggregate([
        { $match: { ...visitMatch, lastEventAt: { $gte: start } } },
        {
          $group: {
            _id: {
              viewer: {
                $cond: [
                  { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
                  { $concat: ["u:", { $toString: "$viewerUserId" }] },
                  { $concat: ["a:", PROJECT_ANON_KEY_EXPR] },
                ],
              },
              visit: "$visitIdHash",
            },
          },
        },
        { $group: { _id: "$_id.viewer", sessions: { $sum: 1 } } },
      ])) as Array<{ _id: string; sessions?: number }>;
      for (const r of rows) sessionsByViewer.set(String(r._id), n0(r.sessions));
    }

    /**
     * Titles for every document any listed viewer opened, in one query rather than per viewer.
     * A document deleted since keeps no entry and reaches the drawer as a `null` title, which the
     * UI renders as "Deleted document" — dropping the row would silently shrink the person's
     * history.
     */
    const viewerDocTitles = new Map<string, string>();
    if (includeViewers) {
      const ids = new Set<string>();
      for (const v of [...viewersAgg, ...anonymousAgg]) {
        for (const d of v.docTimes ?? []) if (d?.docId != null) ids.add(String(d.docId));
      }
      if (ids.size) {
        const metas = await DocModel.find({ _id: { $in: [...ids] } })
          .select({ _id: 1, title: 1, fileName: 1 })
          .lean<Array<{ _id: unknown; title?: string; fileName?: string }>>();
        for (const d of metas) {
          const t = (d.title ?? d.fileName ?? "").trim();
          if (t) viewerDocTitles.set(String(d._id), t);
        }
      }
    }

    /** One row per document this viewer opened, longest read first — the drawer's main list. */
    function viewerDocs(v: RawViewer): Array<{ docId: string; title: string | null; timeSpentMs: number }> {
      const byDocId = new Map<string, number>();
      for (const d of v.docTimes ?? []) {
        if (d?.docId == null) continue;
        const key = String(d.docId);
        byDocId.set(key, (byDocId.get(key) ?? 0) + n0(d.ms));
      }
      return [...byDocId.entries()]
        .map(([docId, timeSpentMs]) => ({ docId, title: viewerDocTitles.get(docId) ?? null, timeSpentMs }))
        .sort((a, b) => b.timeSpentMs - a.timeSpentMs);
    }

    // Window summary (both tiers): unique viewers and total time, grouped by identity without
    // projecting it, so it is safe to run on Basic. The bucket is (link, viewer), like the document
    // route's, which is what keeps the project figure equal to the sum of its `byLink` rows.
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
                // The browser, not (browser × document) — see `PROJECT_ANON_KEY_EXPR`.
                { kind: "anon", key: PROJECT_ANON_KEY_EXPR },
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
      const c = n0(row.viewers);
      if (row._id === "user") windowAuthedViewers += c;
      else windowAnonymousViewers += c;
      windowTimeSpentMs += n0(row.timeSpentMs);
    }
    const viewerCount = windowAuthedViewers + windowAnonymousViewers;

    const mapViewer = (v: RawViewer, kind: "authed" | "anon") => ({
      ...(kind === "authed" ? { userId: String(v.key ?? "") } : { botIdHash: typeof v.key === "string" ? v.key : "" }),
      name: typeof v.viewerName === "string" ? v.viewerName : null,
      email: typeof v.viewerEmailSnapshot === "string" ? v.viewerEmailSnapshot : null,
      views: n0(v.views),
      timeSpentMs: n0(v.timeSpentMs),
      /** Documents this person opened through the project's links — the project's "pages viewed". */
      docsOpened: n0(v.docsOpened),
      /** Which ones, and for how long each — what the drawer shows instead of a per-page chart. */
      docs: viewerDocs(v),
      sessions: sessionsByViewer.get(kind === "authed" ? `u:${String(v.key ?? "")}` : `a:${typeof v.key === "string" ? v.key : ""}`) ?? 0,
      firstSeen: v.firstSeen ? new Date(v.firstSeen).toISOString() : null,
      lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
    });

    const res = NextResponse.json(
      {
        ok: true,
        projectName: name ?? "",
        days,
        analyticsDaysLimit,
        analyticsTier,
        viewerCount,
        totals: {
          views: windowTotals.views,
          ownerPreviews: windowOwnerPreviews,
          opens: windowOpens,
          /** `opens` below `views` means visit rows were never written for that traffic. */
          opensPartial: windowOpens < windowTotals.views,
          // Absent, not zero, when `?viewersOnly=1` skipped the aggregate that produces it.
          ...(viewersOnly ? {} : { downloads: totalDownloads }),
          docsOpened: windowTotals.docsOpened,
          // Project-only, and absent (not zero) on a `viewersOnly=1` response for the same reason
          // `downloads` is: that request never ran the aggregate, and zero would be a claim.
          ...(viewersOnly
            ? {}
            : {
                landings: landings.landings,
                /** Arrived on the project page and opened nothing — see `LandingRollup`. */
                landedWithoutOpening: landings.landedWithoutOpening,
              }),
          timeSpentMs: Math.max(0, Math.floor(windowTimeSpentMs)),
          visitTimeMs,
          authenticatedViewers: windowAuthedViewers,
          anonymousViewers: windowAnonymousViewers,
        },
        totalsAllTime: {
          views: allTimeTotals.views,
          ownerPreviews: allTimeOwnerPreviews,
          opens: allTimeOpens,
          opensPartial: allTimeOpens < allTimeTotals.views,
          ...(viewersOnly ? {} : { downloads: allTimeDownloads }),
          docsOpened: allTimeTotals.docsOpened,
        },
        lastViewedAt: allTimeTotals.lastSeen ? allTimeTotals.lastSeen.toISOString() : null,
        ...(byLink ? { byLink } : {}),
        ...(linksTotal !== null ? { linksTotal } : {}),
        // The project's second ranking. Unlike `byLink` it *does* follow `?shareId=`: "which files
        // did this recipient group open" is the per-link question — see `byDocPipeline`.
        ...(byDoc ? { byDoc } : {}),
        ...(docsTotal !== null ? { docsTotal } : {}),
        ...(topLinksParam === 0 && wantsByLink ? { deletedLinkResidual } : {}),
        // The resolved link in the same DTO shape every other project-link surface uses, so the
        // metrics header can name it and print its settings without a second request.
        ...(link ? { link: toProjectLinkDTO(link) } : {}),
        downloadsEnabled,
        ...(viewersOnly ? {} : { series }),
        viewers: viewersAgg.map((v) => mapViewer(v, "authed")),
        anonymousViewers: anonymousAgg.map((v) => mapViewer(v, "anon")),
      },
      { headers: { "cache-control": "no-store" } },
    );
    return applyTempUserHeaders(res, actor);
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
