/**
 * The one Mongo-facing function behind `GET /api/metrics/workspace`: it builds the whole payload
 * for a workspace and a range. The route stays thin, and the arithmetic stays testable.
 *
 * Three rules shape every query here:
 *
 * - **Scoped by `orgId` and a date window, never a global scan with a later join.** The dashboard
 *   Overview's stats query matches `shareviews` across the whole database and `$lookup`s documents
 *   afterwards; that is what this page must not repeat (PRD, "Problem"). Every read below starts
 *   from `{ orgId, ... }` on an `orgId`-prefixed index.
 * - **Deleted documents are dropped, archived ones are kept.** Views carry a denormalized `orgId`,
 *   so matching on it alone picks up traffic from documents that no longer exist — 48 of 631 rows
 *   in the seed workspace's 30-day window, including the top document by raw count, whose own
 *   metrics page answers 404. Every view match is therefore bounded by the workspace's live
 *   document ids. Archived documents stay in, because `/doc/:docId/metrics` serves them: a document
 *   filed away last week still has the reads it earned, and dropping them here would make this page
 *   disagree with the page it links to. Archived documents are excluded from the *shared*
 *   denominator only, where they follow the plan usage meter.
 * - **Same definitions as the document page.** Recipients only, bounded by last activity, bucketed
 *   by UTC day, viewers counted per (link, viewer). The shared expressions come from
 *   `src/lib/analytics/shareViewAggregates.ts` and `./match.ts`, never re-typed.
 * - **Two collections, one per question.** `shareviews` answers "who" (views, viewers, downloads,
 *   people): one row per (link, browser), lifetime counters inside it. `sharevisits` answers "when
 *   and how long" (opens, reading time): one row per tab session, bounded by `lastEventAt`. Every
 *   range-scoped duration comes from the second — the first cut of this page summed the lifetime
 *   `shareviews.timeSpentMs` into a 7-day tile, which carried months of prior reading into it.
 */
import { Types, type PipelineStage } from "mongoose";

import {
  ACTIVITY_DAY_KEY_EXPR,
  activityWindowMatch,
  LINK_VIEWER_KEY_EXPR,
  RECIPIENT_ONLY_MATCH,
} from "@/lib/analytics/shareViewAggregates";
import type { PlanId } from "@/lib/billing/planLimits";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { UploadModel } from "@/lib/models/Upload";

import {
  LAST_SEEN_MAX_EXPR,
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
} from "./match";
import { resolveWorkspaceRange, utcDayKey, workspacePlanInfo, type ResolvedWorkspaceRange } from "./range";
import {
  avgReadingTimeMs,
  buildSeries,
  delta,
  docMetricsHref,
  linkMetricsHref,
  rankPeople,
  rankTopDocs,
  rankTopLinks,
  safeCount,
  selectQuietDocs,
  toIsoOrNull,
} from "./shape";
import {
  WORKSPACE_PEOPLE_LIMIT,
  WORKSPACE_QUIET_DOCS_LIMIT,
  WORKSPACE_TOP_DOCS_LIMIT,
  WORKSPACE_TOP_LINKS_LIMIT,
  type WorkspaceMetricsResponse,
  type WorkspacePerson,
  type WorkspaceRangeKey,
  type WorkspaceTopDoc,
  type WorkspaceTopLink,
} from "./types";

/**
 * How many link rows the aggregation ranks before the response keeps the top few.
 *
 * A workspace can have thousands of links with traffic in a window; the ranked card shows eight.
 * Cutting inside the pipeline keeps the response (and the memory the `$facet` branch holds) bounded
 * by the page rather than by the workspace.
 */
const LINK_RANK_CANDIDATES = 50;

/** The same, for people: ranked by reading time in Mongo, trimmed to the card's length in Node. */
const PEOPLE_RANK_CANDIDATES = 50;

type DocRow = {
  _id: Types.ObjectId;
  title?: unknown;
  isArchived?: unknown;
  shareEnabled?: unknown;
  createdDate?: unknown;
};

type ByDocRow = { _id?: Types.ObjectId | null; views?: number; viewers?: number; lastSeen?: Date | null };
type VisitByDocRow = { _id?: Types.ObjectId | null; opens?: number; readingTimeMs?: number };
type VisitByDayRow = { _id?: string | null; opens?: number; readingTimeMs?: number };
type VisitTotalsRow = { opens?: number; readingTimeMs?: number };
type ByLinkRow = {
  _id?: { shareId?: string | null; docId?: Types.ObjectId | null } | null;
  views?: number;
  viewers?: number;
  lastSeen?: Date | null;
};
type ByDayRow = { _id?: string | null; views?: number };
type PersonRow = {
  _id?: string | null;
  /** The candidate trim's sort key only — a person's row on the page carries no view count. */
  views?: number;
  docs?: number;
  lastSeen?: Date | null;
  name?: string | null;
  email?: string | null;
};
/** The same person, from the window's visits: the only source of a range-scoped reading time. */
type VisitPersonRow = {
  _id?: string | null;
  readingTimeMs?: number;
  docs?: number;
  lastSeen?: Date | null;
  name?: string | null;
  email?: string | null;
};
type CountRow = { n?: number };
type TotalsRow = { views?: number; viewers?: number };
type DownloadsDayRow = { _id?: string | null; downloads?: number };
type ShareLinkDatesRow = { _id?: Types.ObjectId | null; firstSharedAt?: Date | null; lastLiveSharedAt?: Date | null };

export type WorkspaceMetricsInput = {
  orgId: string | Types.ObjectId;
  plan: PlanId;
  requestedRange: WorkspaceRangeKey;
  /** Injectable clock, so a test can pin the window. */
  now?: Date;
};

/** The empty payload a workspace with no live documents gets: real zeros, never a missing section. */
function emptyResponse(resolved: ResolvedWorkspaceRange, plan: PlanId, isPro: boolean): WorkspaceMetricsResponse {
  const zero = () => delta(0, resolved.previousStart ? 0 : null);
  return {
    ok: true,
    range: resolved.range,
    plan: workspacePlanInfo(plan),
    headline: { views: zero(), opens: zero(), readingTimeMs: zero(), downloads: zero() },
    series: resolved.dayKeys.map((day) => ({ day, views: 0, opens: 0, readingTimeMs: 0, downloads: 0 })),
    docsOpened: { opened: 0, shared: 0, openedOther: 0, returningReaders: 0 },
    topDocs: [],
    topLinks: [],
    people: { count: 0, items: [], gated: !isPro },
    quietDocs: [],
    output: { docsShared: 0, linksCreated: 0, uploads: 0 },
    opensPartial: false,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the workspace metrics payload.
 *
 * Caller supplies the plan (the route already resolved it for the cache key) rather than this
 * re-reading the subscription, so there is exactly one plan decision per request.
 */
export async function loadWorkspaceMetrics(input: WorkspaceMetricsInput): Promise<WorkspaceMetricsResponse> {
  const orgId = input.orgId instanceof Types.ObjectId ? input.orgId : new Types.ObjectId(String(input.orgId));
  const isPro = input.plan === "pro";
  const now = input.now ?? new Date();
  const resolved = resolveWorkspaceRange({ requested: input.requestedRange, plan: input.plan, now });
  const { start, previousStart, previousEnd, dayKeys } = resolved;
  const startKey = utcDayKey(start);

  await connectMongo();

  // The workspace's live documents, read once and reused as the scope of every aggregate below and
  // as the source of every title on the page (no `$lookup` anywhere).
  const docs = (await DocModel.find({ orgId, isDeleted: { $ne: true } })
    .select({ _id: 1, title: 1, isArchived: 1, shareEnabled: 1, createdDate: 1 })
    .lean()) as unknown as DocRow[];

  if (!docs.length) return emptyResponse(resolved, input.plan, isPro);

  const docById = new Map<string, DocRow>();
  const liveDocIds: Types.ObjectId[] = [];
  for (const d of docs) {
    if (!d?._id) continue;
    docById.set(String(d._id), d);
    liveDocIds.push(d._id);
  }
  const titleOf = (docId: string) => {
    const raw = docById.get(docId)?.title;
    const t = typeof raw === "string" ? raw.trim() : "";
    return t || "Untitled";
  };

  // "Shared documents": the plan usage meter's definition (sharing on, not deleted, not archived),
  // so "opened 12 of 31 shared" and the Free cap count the same documents.
  const sharedDocs = docs
    .filter((d) => d.shareEnabled !== false && d.isArchived !== true)
    .map((d) => ({ docId: String(d._id), title: titleOf(String(d._id)), createdDate: d.createdDate }));
  const sharedDocIds = new Set(sharedDocs.map((d) => d.docId));

  // `orgId` as an index hint, `docId` as the tenancy boundary — see `workspaceOrgMatch`.
  const viewScope = { ...workspaceOrgMatch(orgId), docId: { $in: liveDocIds }, ...RECIPIENT_ONLY_MATCH };
  const visitScope = { ...workspaceOrgMatch(orgId), docId: { $in: liveDocIds }, ...RECIPIENT_ONLY_MATCH };
  const currentMatch = { ...viewScope, ...activityWindowMatch(start) };

  /** One (document, link, viewer) bucket per reader of a link — see `WORKSPACE_VIEWER_KEY_EXPR`. */
  const viewerGroupStage = {
    $group: {
      _id: WORKSPACE_VIEWER_KEY_EXPR,
      views: { $sum: 1 },
      lastSeen: LAST_SEEN_MAX_EXPR,
    },
  };

  /**
   * Everything that comes from `shareviews` in the window, in one index scan.
   *
   * `$facet` because the branches need different groupings of the *same* rows: views by day are
   * counted per row (the document page's series semantics), while viewers are rolled up per
   * (link, viewer) first. Two pipelines would scan the window twice and could drift.
   *
   * Reading time is **not** here. It is a range figure, so it comes from `sharevisits` below.
   */
  const facetStage: Record<string, PipelineStage.FacetPipelineStage[]> = {
    byDay: [{ $group: { _id: ACTIVITY_DAY_KEY_EXPR, views: { $sum: 1 } } }],
    byDoc: [
      viewerGroupStage,
      {
        $group: {
          _id: "$_id.docId",
          views: { $sum: "$views" },
          viewers: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
        },
      },
    ],
    byLink: [
      viewerGroupStage,
      {
        $group: {
          _id: { shareId: "$_id.shareId", docId: "$_id.docId" },
          views: { $sum: "$views" },
          viewers: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
        },
      },
      { $sort: { views: -1, lastSeen: -1 } },
      { $limit: LINK_RANK_CANDIDATES },
    ],
    // Distinct named people, on both plans: a `$group` key is not a projection, so nothing
    // identifying leaves Mongo on Free.
    peopleCount: [
      { $match: WORKSPACE_NAMED_ROW_MATCH },
      { $group: { _id: WORKSPACE_PERSON_KEY_EXPR } },
      { $match: { _id: { $ne: null } } },
      { $count: "n" },
    ],
  };

  // Pro only, and withheld rather than hidden: on Free this branch is never added to the pipeline,
  // so no name or email is read, let alone serialized ([[viewer identity gate]]).
  //
  // This branch carries the *views* side of a person only — how many of the workspace's documents
  // they were active on in the window, and the identity to print. Their reading time comes from
  // the visit facet below, because `shareviews.timeSpentMs` is a lifetime counter: summing it here
  // reported reading that happened before the range the control names (one seed reader carried
  // 148s of which 60s predated the 7-day window). The rows of this branch are also the fallback
  // pool, so a reader whose traffic predates visit rows is still listed rather than dropped.
  if (isPro) {
    facetStage.people = [
      { $match: WORKSPACE_NAMED_ROW_MATCH },
      {
        // Per (person, document) first, so `docs` counts documents rather than links.
        $group: {
          _id: { key: WORKSPACE_PERSON_KEY_EXPR, docId: "$docId" },
          views: { $sum: 1 },
          lastSeen: LAST_SEEN_MAX_EXPR,
          // `$max` rather than `$first`: the rows of one person carry the same name, and taking the
          // maximum is deterministic without paying for a blocking `$sort` inside the facet.
          name: { $max: "$viewerName" },
          email: { $max: { $ifNull: ["$viewerEmailSnapshot", "$viewerEmail"] } },
        },
      },
      { $match: { "_id.key": { $ne: null } } },
      {
        $group: {
          _id: "$_id.key",
          views: { $sum: "$views" },
          docs: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
          name: { $max: "$name" },
          email: { $max: "$email" },
        },
      },
      { $sort: { views: -1, lastSeen: -1 } },
      { $limit: PEOPLE_RANK_CANDIDATES },
    ];
  }

  const downloadsPipeline = (windowStart: Date, fromKey: string, toKeyExclusive: string | null) => [
    // `downloads: { $gt: 0 }` keeps the scan off the rows that cannot contribute. Safe because every
    // download ingest also stamps `lastViewedAt`, so a row with a download inside the window is
    // always active in it (verified on the dev corpus for 7 and 30 days).
    { $match: { ...viewScope, downloads: { $gt: 0 }, ...activityWindowMatch(windowStart) } },
    { $project: { items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
    { $unwind: "$items" },
    { $match: { "items.k": toKeyExclusive ? { $gte: fromKey, $lt: toKeyExclusive } : { $gte: fromKey } } },
    { $group: { _id: "$items.k", downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
  ];

  /**
   * Opens, reading time and returning readers, in one scan of the window's visits.
   *
   * One row per tab session, so `opens` counts events and `readingTimeMs` is time read *inside* the
   * window rather than the lifetime of the readers who happened to be active in it.
   *
   * `returning` counts readers, and is counted rather than derived. `opens - views` is the *surplus
   * sessions*, which is a different number and always the larger one: on the seed workspace's 30-day
   * window it said 123 where 72 readers actually came back, and one reader with 78 sittings would
   * have printed "77 readers came back". The grouping key is `LINK_VIEWER_KEY_EXPR`, so a "reader"
   * here is the same reader the view and viewer counts are built on.
   */
  const visitFacetStage: Record<string, PipelineStage.FacetPipelineStage[]> = {
    byDay: [{ $group: { _id: VISIT_DAY_KEY_EXPR, opens: { $sum: 1 }, readingTimeMs: VISIT_TIME_SUM_EXPR } }],
    byDoc: [{ $group: { _id: "$docId", opens: { $sum: 1 }, readingTimeMs: VISIT_TIME_SUM_EXPR } }],
    returning: [
      { $group: { _id: LINK_VIEWER_KEY_EXPR, opens: { $sum: 1 } } },
      { $match: { opens: { $gt: 1 } } },
      { $count: "n" },
    ],
  };

  // The people list's reading time and its ranking, from the same visits: a range figure from a
  // range source. Identity, `lastEventAt` and `docId` are all on the visit row, so this branch is
  // self-sufficient for a row the card can render; the `shareviews` branch above only adds `views`
  // and the readers who have no visit row at all. Pro only, same gate and same reason as above.
  if (isPro) {
    visitFacetStage.people = [
      { $match: WORKSPACE_NAMED_ROW_MATCH },
      {
        // Per (person, document), so `docs` counts documents rather than sessions.
        $group: {
          _id: { key: WORKSPACE_PERSON_KEY_EXPR, docId: "$docId" },
          readingTimeMs: VISIT_TIME_SUM_EXPR,
          lastSeen: { $max: "$lastEventAt" },
          name: { $max: "$viewerName" },
          email: { $max: { $ifNull: ["$viewerEmailSnapshot", "$viewerEmail"] } },
        },
      },
      { $match: { "_id.key": { $ne: null } } },
      {
        $group: {
          _id: "$_id.key",
          readingTimeMs: { $sum: "$readingTimeMs" },
          docs: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
          name: { $max: "$name" },
          email: { $max: "$email" },
        },
      },
      // Ranked on the figure the card prints, so the candidates Mongo keeps are the top readers of
      // the window and not the top readers of all time.
      { $sort: { readingTimeMs: -1, lastSeen: -1 } },
      { $limit: PEOPLE_RANK_CANDIDATES },
    ];
  }

  const [
    facetRows,
    visitFacetRows,
    previousTotalsRows,
    previousVisitTotalsRows,
    downloadsRows,
    previousDownloadsRows,
    shareLinkDateRows,
    linksCreated,
    uploads,
  ] = await Promise.all([
      ShareViewModel.aggregate([{ $match: currentMatch }, { $facet: facetStage }], { allowDiskUse: true }) as Promise<
        Array<Record<string, unknown[]>>
      >,
      ShareVisitModel.aggregate(
        [{ $match: { ...visitScope, ...visitWindowMatch(start) } }, { $facet: visitFacetStage }],
        { allowDiskUse: true },
      ) as Promise<Array<Record<string, unknown[]>>>,
      previousStart && previousEnd
        ? (ShareViewModel.aggregate(
            [
              // `presenceBetweenMatch`, not `activityBetweenMatch`: a reader who was here last month
              // and came back this month must stay in the baseline, or every chip reads high.
              { $match: { ...viewScope, ...presenceBetweenMatch(previousStart, previousEnd) } },
              viewerGroupStage,
              { $group: { _id: null, views: { $sum: "$views" }, viewers: { $sum: 1 } } },
            ],
            { allowDiskUse: true },
          ) as Promise<TotalsRow[]>)
        : Promise.resolve<TotalsRow[]>([]),
      previousStart && previousEnd
        ? (ShareVisitModel.aggregate(
            [
              { $match: { ...visitScope, ...visitBetweenMatch(previousStart, previousEnd) } },
              { $group: { _id: null, opens: { $sum: 1 }, readingTimeMs: VISIT_TIME_SUM_EXPR } },
            ],
            { allowDiskUse: true },
          ) as Promise<VisitTotalsRow[]>)
        : Promise.resolve<VisitTotalsRow[]>([]),
      ShareViewModel.aggregate(downloadsPipeline(start, startKey, null), { allowDiskUse: true }) as Promise<DownloadsDayRow[]>,
      previousStart
        ? (ShareViewModel.aggregate(downloadsPipeline(previousStart, utcDayKey(previousStart), startKey), {
            allowDiskUse: true,
          }) as Promise<DownloadsDayRow[]>)
        : Promise.resolve<DownloadsDayRow[]>([]),
      // Two share dates per document, from one pass over its links. There is no `Doc.sharedAt`, and
      // the activity feed cannot stand in for one — the default links created by the multi-links
      // migration have no `share_link.created` event.
      //
      // `firstSharedAt` (any link, whatever state it is in now) dates the "documents shared" figure:
      // a deck sent on Tuesday was shared this week even if its link was switched off on Friday.
      // `lastLiveSharedAt` (newest link a recipient could open today) dates the quiet list, which
      // must not nudge anyone about a link that is disabled, archived or expired. `$max` ignores the
      // nulls the `$cond` produces, so a document with no live link simply has none.
      ShareLinkModel.aggregate(
        [
          { $match: { orgId, docId: { $in: liveDocIds } } },
          {
            $group: {
              _id: "$docId",
              firstSharedAt: { $min: "$createdDate" },
              lastLiveSharedAt: { $max: { $cond: [liveShareLinkExpr(now), "$createdDate", null] } },
            },
          },
        ],
        { allowDiskUse: true },
      ) as Promise<ShareLinkDatesRow[]>,
      ShareLinkModel.countDocuments({ orgId, docId: { $in: liveDocIds }, createdDate: { $gte: start } }),
      // Counted by `docId`, not `orgId`: the upload path leaves `Upload.orgId` null on all but a
      // handful of rows (216 of 217 in the seed workspace), so an `orgId` count reports 1.
      UploadModel.countDocuments({
        docId: { $in: liveDocIds },
        status: "completed",
        isDeleted: { $ne: true },
        createdDate: { $gte: start },
      }),
    ]);

  const facet = facetRows[0] ?? {};
  const byDoc = (facet.byDoc ?? []) as ByDocRow[];
  const byLink = (facet.byLink ?? []) as ByLinkRow[];
  const byDay = (facet.byDay ?? []) as ByDayRow[];
  const visitFacet = visitFacetRows[0] ?? {};
  const visitByDoc = (visitFacet.byDoc ?? []) as VisitByDocRow[];
  const visitByDay = (visitFacet.byDay ?? []) as VisitByDayRow[];
  const opensByDocId = new Map<string, VisitByDocRow>(
    visitByDoc.filter((r) => r?._id).map((r) => [String(r._id), r] as const),
  );
  const peopleRows = (facet.people ?? []) as PersonRow[];
  const visitPeopleRows = (visitFacet.people ?? []) as VisitPersonRow[];
  const peopleCount = safeCount(((facet.peopleCount ?? []) as CountRow[])[0]?.n);
  const returningReaders = safeCount(((visitFacet.returning ?? []) as CountRow[])[0]?.n);

  // Headline totals are the sums of the document rows, so the page total and the ranked list under
  // it cannot disagree, and deleted documents are excluded by construction (they never matched).
  let views = 0;
  const openedDocIds = new Set<string>();
  const topDocCandidates: WorkspaceTopDoc[] = [];
  for (const row of byDoc) {
    const docId = row?._id ? String(row._id) : "";
    if (!docId || !docById.has(docId)) continue;
    const rowViews = safeCount(row.views);
    const rowViewers = safeCount(row.viewers);
    // Opens and reading time are the visit row's, joined by document id. A document with views and
    // no visit row is traffic older than visits — that is what `opensPartial` below reports.
    const visit = opensByDocId.get(docId);
    const rowOpens = safeCount(visit?.opens);
    const rowMs = safeCount(visit?.readingTimeMs);
    views += rowViews;
    openedDocIds.add(docId);
    topDocCandidates.push({
      docId,
      title: titleOf(docId),
      views: rowViews,
      viewers: rowViewers,
      opens: rowOpens,
      readingTimeMs: rowMs,
      avgReadingTimeMs: avgReadingTimeMs(rowMs, rowViewers),
      lastOpenedAt: toIsoOrNull(row.lastSeen),
      href: docMetricsHref(docId),
    });
  }

  // Headline opens and reading time are the visit window's own totals, not a sum over the documents
  // above: a visit row on a document whose views all predate the window would otherwise be dropped,
  // and the area under the chart has to equal the tile.
  const opens = visitByDay.reduce((acc, r) => acc + safeCount(r.opens), 0);
  const readingTimeMs = visitByDay.reduce((acc, r) => acc + safeCount(r.readingTimeMs), 0);
  for (const row of visitByDoc) {
    const docId = row?._id ? String(row._id) : "";
    if (docId && docById.has(docId)) openedDocIds.add(docId);
  }

  // `opens` can never honestly be below `views` — every viewer had at least one sitting — so when it
  // is, the visit rows for that traffic were never written and the figure is a floor. Same rule and
  // same name as the document route's `totals.opensPartial`, so both pages withhold it together.
  const opensPartial = opens < views;

  const downloads = downloadsRows.reduce((acc, r) => acc + safeCount(r.downloads), 0);
  // A previous period was *served* even when nothing happened in it: the comparison is then 0, not
  // withheld. Only a plan that withholds history (Free) leaves these `null`.
  const previousServed = Boolean(previousStart);
  const previousTotals = previousTotalsRows[0] ?? null;
  const previousVisitTotals = previousVisitTotalsRows[0] ?? null;
  const previousOf = (v: unknown): number | null => (previousServed ? safeCount(v) : null);
  const previousDownloads = previousStart
    ? previousDownloadsRows.reduce((acc, r) => acc + safeCount(r.downloads), 0)
    : null;

  const series = buildSeries(dayKeys, {
    views: new Map(byDay.map((r) => [String(r._id ?? ""), safeCount(r.views)])),
    opens: new Map(visitByDay.map((r) => [String(r._id ?? ""), safeCount(r.opens)])),
    readingTimeMs: new Map(visitByDay.map((r) => [String(r._id ?? ""), safeCount(r.readingTimeMs)])),
    downloads: new Map(downloadsRows.map((r) => [String(r._id ?? ""), safeCount(r.downloads)])),
  });

  // Link labels for the rows that survived the ranking only: private-to-sender text, fetched for at
  // most a page's worth of links rather than for every link with traffic.
  const rankedLinks = rankTopLinks(
    byLink
      .map((row): WorkspaceTopLink | null => {
        const shareId = typeof row?._id?.shareId === "string" ? row._id.shareId : "";
        const docId = row?._id?.docId ? String(row._id.docId) : "";
        if (!shareId || !docId || !docById.has(docId)) return null;
        return {
          shareId,
          shareLinkId: null,
          label: "",
          audience: null,
          isDefault: false,
          docId,
          docTitle: titleOf(docId),
          views: safeCount(row.views),
          viewers: safeCount(row.viewers),
          lastOpenedAt: toIsoOrNull(row.lastSeen),
          href: linkMetricsHref(docId, shareId),
        };
      })
      .filter((r): r is WorkspaceTopLink => r !== null),
    WORKSPACE_TOP_LINKS_LIMIT,
  );

  if (rankedLinks.length) {
    const linkDocs = (await ShareLinkModel.find({ orgId, shareId: { $in: rankedLinks.map((l) => l.shareId) } })
      .select({ _id: 1, shareId: 1, label: 1, audience: 1, isDefault: 1 })
      .lean()) as unknown as Array<{
      _id?: Types.ObjectId;
      shareId?: string;
      label?: unknown;
      audience?: unknown;
      isDefault?: unknown;
    }>;
    const linkByShareId = new Map(linkDocs.map((l) => [String(l.shareId ?? ""), l]));
    for (const row of rankedLinks) {
      const link = linkByShareId.get(row.shareId);
      // A link row can be gone (hard-deleted) while its views remain; the document's title is then
      // the only honest name for it, which is also what a default link would show.
      row.shareLinkId = link?._id ? String(link._id) : null;
      const label = typeof link?.label === "string" ? link.label.trim() : "";
      row.label = label || row.docTitle;
      const audience = typeof link?.audience === "string" ? link.audience.trim() : "";
      row.audience = audience || null;
      row.isDefault = link?.isDefault === true;
    }
  }

  /**
   * One row per person, from the two pools.
   *
   * The visit rows carry the reading time the card ranks and prints (in-window, by construction);
   * the view rows carry `views` and, for a reader with no visit row in the window at all — traffic
   * older than visits — the whole row, with a reading time of `0` rather than the lifetime counter.
   * That is the same choice the document rows above make, so a card figure and its headline are
   * measured the same way; `opensPartial` is what tells a reader the visit side is incomplete.
   */
  const viewPersonByKey = new Map<string, PersonRow>();
  for (const row of peopleRows) if (typeof row?._id === "string" && row._id) viewPersonByKey.set(row._id, row);
  const trimmed = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const people: WorkspacePerson[] = isPro
    ? rankPeople(
        (() => {
          const rows: WorkspacePerson[] = [];
          const seen = new Set<string>();
          for (const row of visitPeopleRows) {
            const key = typeof row?._id === "string" ? row._id : "";
            if (!key) continue;
            seen.add(key);
            const view = viewPersonByKey.get(key);
            rows.push({
              key,
              name: trimmed(row.name) ?? trimmed(view?.name),
              email: (trimmed(row.email) ?? trimmed(view?.email))?.toLowerCase() ?? null,
              readingTimeMs: safeCount(row.readingTimeMs),
              // `docs` follows the view rows where there are any, so the people card and the rest of
              // the page count a document the same way; a person outside that pool's candidates is
              // described by their visits instead.
              docs: view ? safeCount(view.docs) : safeCount(row.docs),
              lastSeenAt: toIsoOrNull(view?.lastSeen ?? row.lastSeen),
            });
          }
          for (const row of peopleRows) {
            const key = typeof row?._id === "string" ? row._id : "";
            if (!key || seen.has(key)) continue;
            rows.push({
              key,
              name: trimmed(row.name),
              email: trimmed(row.email)?.toLowerCase() ?? null,
              readingTimeMs: 0,
              docs: safeCount(row.docs),
              lastSeenAt: toIsoOrNull(row.lastSeen),
            });
          }
          return rows;
        })(),
        WORKSPACE_PEOPLE_LIMIT,
      )
    : [];

  const firstSharedById = new Map<string, string | null>();
  const lastLiveSharedById = new Map<string, string | null>();
  for (const r of shareLinkDateRows) {
    const docId = r?._id ? String(r._id) : "";
    if (!docId) continue;
    firstSharedById.set(docId, toIsoOrNull(r.firstSharedAt));
    lastLiveSharedById.set(docId, toIsoOrNull(r.lastLiveSharedAt));
  }
  const startIso = start.toISOString();

  // One scope for the whole output line. `linksCreated` and `uploads` count every live document, so
  // this clause does too: scoping only it to the usage meter's set said "66 documents shared · 214
  // links created" while counting the links of 86 documents. It is why the sentence says "got their
  // first link" rather than "shared" — over the wider scope this figure (124 on the seed workspace)
  // runs above `docsOpened.shared` (104), and two clauses on one page both reading "shared" made
  // that difference look like a bug instead of two different questions.
  //
  // No `Doc.createdDate` fallback: a document with no `ShareLink` has never been shared, and dating
  // it by its upload counted an unshared document as shared.
  const docsShared = docs.reduce((acc, d) => {
    const first = firstSharedById.get(String(d._id));
    return acc + (first && first >= startIso ? 1 : 0);
  }, 0);

  // The quiet list is the PRD's definition and not the usage meter's: a document is only worth a
  // nudge if a recipient could open it today, so it is dated by its newest *live* link and a
  // document with none is absent rather than dated by something else.
  const quietDocs = selectQuietDocs(
    sharedDocs.map((d) => ({
      docId: d.docId,
      title: d.title,
      sharedAt: lastLiveSharedById.get(d.docId) ?? null,
    })),
    openedDocIds,
    WORKSPACE_QUIET_DOCS_LIMIT,
    now.getTime(),
  );

  let openedShared = 0;
  for (const docId of openedDocIds) if (sharedDocIds.has(docId)) openedShared += 1;
  // Documents that were read but are outside the `shared` denominator (archived, or sharing off).
  // They are in the headline and can be ranked below, so the sentence names them instead of leaving
  // "51 of 104" to be quietly shorter than the list under it.
  const openedOther = openedDocIds.size - openedShared;

  return {
    ok: true,
    range: resolved.range,
    plan: workspacePlanInfo(input.plan),
    headline: {
      views: delta(views, previousOf(previousTotals?.views)),
      opens: delta(opens, previousOf(previousVisitTotals?.opens)),
      readingTimeMs: delta(readingTimeMs, previousOf(previousVisitTotals?.readingTimeMs)),
      downloads: delta(downloads, previousDownloads),
    },
    series,
    docsOpened: {
      opened: openedShared,
      shared: sharedDocs.length,
      openedOther,
      returningReaders: opensPartial ? null : returningReaders,
    },
    topDocs: rankTopDocs(topDocCandidates, WORKSPACE_TOP_DOCS_LIMIT),
    topLinks: rankedLinks,
    people: { count: peopleCount, items: people, gated: !isPro },
    quietDocs,
    output: { docsShared, linksCreated: safeCount(linksCreated), uploads: safeCount(uploads) },
    opensPartial,
    generatedAt: new Date().toISOString(),
  };
}
