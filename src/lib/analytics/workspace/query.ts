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

import { projectLinkSlugsForOrg } from "@/lib/analytics/docScope";
import { loadContributors } from "./contributors";
import { PROJECT_ANON_KEY_EXPR, splitProjectViewerKey } from "@/lib/analytics/project/viewerKey";
import {
  ACTIVITY_DAY_KEY_EXPR,
  activityWindowMatch,
  LINK_VIEWER_KEY_EXPR,
  RECIPIENT_ONLY_MATCH,
} from "@/lib/analytics/shareViewAggregates";
import type { PlanId } from "@/lib/billing/planLimits";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { UploadModel } from "@/lib/models/Upload";

import {
  LAST_SEEN_MAX_EXPR,
  linkReaderKeyExpr,
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
  buildTopLinks,
  delta,
  docMetricsHref,
  rankPeople,
  rankTopDocs,
  safeCount,
  selectQuietDocs,
  toIsoOrNull,
  type WorkspaceLinkCandidate,
  type WorkspaceLinkIdentity,
} from "./shape";
import {
  WORKSPACE_PEOPLE_LIMIT,
  WORKSPACE_RECENT_PEOPLE_LIMIT,
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

/**
 * One document's window, counted twice over the same buckets — see the `byDoc` facet.
 *
 * `views` / `viewers` / `lastSeen` are every read the workspace saw (the headline's basis);
 * `ownViews` / `ownViewers` / `ownLastSeen` are the document's own, with project-link reads left
 * out, and are what the ranked row prints beside a link to the document's metrics page.
 */
type ByDocRow = {
  _id?: Types.ObjectId | null;
  views?: number;
  viewers?: number;
  lastSeen?: Date | null;
  ownViews?: number;
  ownViewers?: number;
  ownLastSeen?: Date | null;
};
type VisitByDocRow = {
  _id?: Types.ObjectId | null;
  opens?: number;
  readingTimeMs?: number;
  ownOpens?: number;
  ownReadingTimeMs?: number;
};
type VisitByDayRow = { _id?: string | null; opens?: number; readingTimeMs?: number };
type VisitTotalsRow = { opens?: number; readingTimeMs?: number };
/** One link's window, already collapsed to a single row per `shareId` — see the `byLink` facet. */
type ByLinkRow = {
  _id?: string | null;
  /** `ShareView` rows — (viewer × document opened) under a project link. */
  rows?: number;
  /** Distinct readers of the link, with a project link's document stripped out of the viewer key. */
  readers?: number;
  /** Every live document the link was opened on: one for a document link, several for a project one. */
  docIds?: Array<Types.ObjectId | string> | null;
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
  /** Pages reached in each document they opened — the grain the reading badge has to be judged at. */
  perDoc?: Array<{ docId?: unknown; pages?: unknown; ownReads?: unknown; projectSlug?: unknown }>;
  /** Their identity in URL terms, for the link from a row to their reader page. */
  viewerUserId?: unknown;
  botIdHash?: unknown;
};
/** The same person, from the window's visits: the only source of a range-scoped reading time. */
type VisitPersonRow = {
  _id?: string | null;
  readingTimeMs?: number;
  docs?: number;
  lastSeen?: Date | null;
  name?: string | null;
  email?: string | null;
  /** Time spent in each document they opened, paired with `PersonRow.perDoc` by `docId`. */
  perDoc?: Array<{ docId?: unknown; readingTimeMs?: unknown }>;
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
    people: { count: 0, items: [], recent: [], gated: !isPro },
    quietDocs: [],
    output: { docsShared: 0, linksCreated: 0, uploads: 0 },
    contributors: [],
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
  //
  // Beside it, the workspace's project-link slugs (`@/lib/analytics/docScope`), which are what makes
  // a *document-scoped* figure on this page mean the same thing as the document's own page: a read
  // through a data room is the project's view, never the document's. They are fetched here, in
  // parallel with the documents, because the facet below has to be built with them in hand.
  const [docs, projectShareIds] = (await Promise.all([
    DocModel.find({ orgId, isDeleted: { $ne: true } })
      .select({ _id: 1, title: 1, isArchived: 1, shareEnabled: 1, createdDate: 1, currentUploadId: 1 })
      .lean(),
    projectLinkSlugsForOrg(orgId),
  ])) as unknown as [DocRow[], string[]];

  if (!docs.length) return emptyResponse(resolved, input.plan, isPro);

  /**
   * How many pages each document has, from the upload its current version points at.
   *
   * Only the reading badge needs this, and only as a denominator: without it a reader who spent
   * six minutes on one page of a nine-page deck reads as "Read" here and "Started" on the
   * document's own page, which is the contradiction that kept the badge off this card. One lean
   * read over the workspace's uploads, projected to a single number.
   */
  const pagesByDocId = new Map<string, number>();
  {
    const uploadIdByDoc = new Map<string, string>();
    for (const d of docs as Array<DocRow & { currentUploadId?: unknown }>) {
      if (d.currentUploadId) uploadIdByDoc.set(String(d._id), String(d.currentUploadId));
    }
    const uploadIds = [...new Set(uploadIdByDoc.values())]
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (uploadIds.length) {
      const uploads = (await UploadModel.find({ _id: { $in: uploadIds } })
        .select({ _id: 1, "metadata.pages": 1 })
        .lean()) as Array<{ _id: Types.ObjectId; metadata?: { pages?: unknown } }>;
      const pagesByUpload = new Map<string, number>();
      for (const u of uploads) {
        const n = u?.metadata?.pages;
        if (typeof n === "number" && Number.isFinite(n) && n > 0) pagesByUpload.set(String(u._id), Math.floor(n));
      }
      for (const [docId, uploadId] of uploadIdByDoc) {
        const pages = pagesByUpload.get(uploadId);
        if (pages) pagesByDocId.set(docId, pages);
      }
    }
  }

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
   * "This value, but only when the row is the document's own read" — the in-pipeline form of
   * `docOnlyShareIdMatch`'s `$nin`.
   *
   * A `$cond` rather than a second `$match`, because the same rows have to be counted *both* ways in
   * one scan: the workspace headline counts every reading exactly once (a data-room read is a read
   * the workspace had), while a per-document row must equal the document page it links to, which
   * does not count it. Splitting the pipeline instead would scan the window twice and let the two
   * answers drift.
   *
   * `slugField` is `$_id.shareId` after the viewer grouping and `$shareId` on a raw row. With no
   * project links in the workspace the expression collapses to the plain value, so nothing is paid
   * for a feature a workspace does not use.
   */
  const ownOnly = (slugField: string, value: unknown, otherwise: unknown) =>
    projectShareIds.length ? { $cond: [{ $in: [slugField, projectShareIds] }, otherwise, value] } : value;

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
    // Two counts per document, from one grouping — see `ownOnly`. The plain trio feeds the
    // headline and `docsOpened` (workspace scope: the reading happened, and this page is the
    // workspace's); the `own*` trio feeds the ranked row, which prints a per-document figure beside
    // a link to `/doc/:docId/metrics` and must therefore equal it. Before this split the card said
    // "USAVX Deck · 13 views" and opened a page reading 7, and listed a one-pager whose own page
    // says nobody has ever opened it.
    byDoc: [
      viewerGroupStage,
      {
        $group: {
          _id: "$_id.docId",
          views: { $sum: "$views" },
          viewers: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
          ownViews: { $sum: ownOnly("$_id.shareId", "$views", 0) },
          ownViewers: { $sum: ownOnly("$_id.shareId", 1, 0) },
          ownLastSeen: { $max: ownOnly("$_id.shareId", "$lastSeen", null) },
        },
      },
    ],
    // One row per **link**, not per (link, document).
    //
    // A project link is one `shareId` spanning every document opened through it, so grouping on
    // `{ shareId, docId }` printed it once per document, each row holding a slice of its traffic
    // under a document's title and pointing at a document metrics page that refuses it. Collapsing
    // to `shareId` here changes nothing for a document link — all of its views carry the one
    // `docId` — and makes the duplicate rows impossible rather than de-duplicated downstream.
    //
    // Two counts, because a project link is the one case where they differ. `rows` is `ShareView`
    // rows — (viewer × document opened) under a project link. `readers` is distinct readers of the
    // *link*: the buckets below are (document, link, reader) and a project link spells the document
    // into the reader's own key, so one person who opened three documents in a data room arrives as
    // three buckets under three different keys. `linkReaderKeyExpr` strips that composite back to
    // the person; a document link's key has nothing to strip, so its two counts stay equal and its
    // row is exactly what it was. Which one becomes the row's `views` is `buildTopLink`'s call.
    byLink: [
      viewerGroupStage,
      {
        $group: {
          _id: "$_id.shareId",
          rows: { $sum: "$views" },
          readerKeys: { $addToSet: linkReaderKeyExpr("$_id.viewer") },
          docIds: { $addToSet: "$_id.docId" },
          lastSeen: { $max: "$lastSeen" },
        },
      },
      { $project: { rows: 1, docIds: 1, lastSeen: 1, readers: { $size: "$readerKeys" } } },
      // A generous pre-cut so the `$facet` branch stays page-sized; the order that reaches the card
      // is settled in Node, once each row's kind says which of the two counts it prints.
      { $sort: { rows: -1, lastSeen: -1 } },
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
          // Which pages of THIS document they reached. Kept per document because that is the only
          // scope where a page number means anything: page 3 of the deck is not page 3 of the term
          // sheet, so a union across documents would be a number about nothing.
          pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } },
          // Who they are in a URL, and whether this reading can be reached on the document's own
          // reader page — a read through a project link belongs to the project, so the document's
          // page would answer "no reader by that id" for it.
          viewerUserId: { $max: "$viewerUserId" },
          botIdHash: { $max: "$botIdHash" },
          ownReads: { $sum: ownOnly("$shareId", 1, 0) },
          // The project link they came through, when they came through one: their reading lives on
          // that project's pages, so that is where a click on their row belongs.
          projectSlug: { $max: ownOnly("$shareId", null, "$shareId") },
        },
      },
      { $match: { "_id.key": { $ne: null } } },
      {
        $addFields: {
          pages: {
            $size: {
              $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } },
            },
          },
        },
      },
      {
        $group: {
          _id: "$_id.key",
          views: { $sum: "$views" },
          docs: { $sum: 1 },
          lastSeen: { $max: "$lastSeen" },
          name: { $max: "$name" },
          email: { $max: "$email" },
          // One entry per document this person opened, so the reading badge can be judged the way
          // the document's own page judges it rather than by a workspace-wide average.
          perDoc: { $push: { docId: "$_id.docId", pages: "$pages", ownReads: "$ownReads", projectSlug: "$projectSlug" } },
          viewerUserId: { $max: "$viewerUserId" },
          botIdHash: { $max: "$botIdHash" },
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
   * One row per tab session **per document**, which is the detail these two facets turn on. A
   * project link keys its rows by `<digest>.<docId>` so three files behind one slug do not collide
   * (`projectViewerKey`), and its `visitIdHash` is stored per link — so one sitting in a data room
   * that opened two documents is two rows sharing a visit id. `readingTimeMs` is time read *inside*
   * the window rather than the lifetime of the readers who happened to be active in it.
   *
   * `returning` counts readers, and is counted rather than derived. `opens - views` is the *surplus
   * sessions*, which is a different number and always the larger one: on the seed workspace's 30-day
   * window it said 123 where 72 readers actually came back, and one reader with 78 sittings would
   * have printed "77 readers came back". The grouping key is `LINK_VIEWER_KEY_EXPR`, so a "reader"
   * here is the same reader the view and viewer counts are built on.
   */
  const visitFacetStage: Record<string, PipelineStage.FacetPipelineStage[]> = {
    /**
     * Sessions, not rows.
     *
     * `$sum: 1` over the rows called one sitting in a data room two opens, because that sitting
     * wrote a row per document. `docs/METRICS.md` defines Opens as tab sessions, and the project
     * route already collapses them the same way (`countSessions`) — this was the surface still
     * answering a different question with the same word. Measured on the launch workspace's
     * 30-day window: 39 rows, 37 sessions.
     *
     * The time is summed across the session's rows rather than deduped with it: each row holds the
     * time spent in its own document, and the sitting's reading time is their total.
     *
     * Grouping by the day of each row means a session straddling midnight is counted on both days,
     * which is what a per-day series should say.
     */
    byDay: [
      {
        $group: {
          _id: { day: VISIT_DAY_KEY_EXPR, shareId: "$shareId", visit: "$visitIdHash" },
          readingTimeMs: VISIT_TIME_SUM_EXPR,
        },
      },
      { $group: { _id: "$_id.day", opens: { $sum: 1 }, readingTimeMs: { $sum: "$readingTimeMs" } } },
    ],
    // Same split as the view facet's `byDoc`, and for the same reason: the ranked row's opens and
    // reading time have to come from the document's own links, or a row reconciles on views and
    // disagrees on everything beside them.
    //
    // No session collapse here, unlike `byDay` above: a row is already one session *per document*,
    // and this facet is per document. Deduping on `{docId, shareId, visitIdHash}` changes nothing —
    // 39 rows, 39 per-document sessions on the same window that has 37 sittings — and a sitting
    // that opened two documents is genuinely one open of each.
    byDoc: [
      {
        $group: {
          _id: "$docId",
          opens: { $sum: 1 },
          readingTimeMs: VISIT_TIME_SUM_EXPR,
          ownOpens: { $sum: ownOnly("$shareId", 1, 0) },
          ownReadingTimeMs: { $sum: ownOnly("$shareId", { $ifNull: ["$timeSpentMs", 0] }, 0) },
        },
      },
    ],
    /**
     * Readers who came back: more than one *sitting*, by a person rather than by a stored key.
     *
     * Both halves were wrong in the same direction. The key was `LINK_VIEWER_KEY_EXPR`, which on a
     * project link carries the document (`<digest>.<docId>`), so one reader split into one "reader"
     * per file they opened — the same mistake `linkReaderKeyExpr` exists to fix a hundred lines
     * above, with a comment saying so. And the count was of rows, so a single sitting that opened
     * two documents already looked like a return visit. On the launch workspace both compounded:
     * 3 readers reported, 2 real.
     *
     * Sessions first, then readers with more than one. The reader stays link-scoped, so "a reader"
     * here is still the reader the view and viewer counts are built on.
     */
    returning: [
      {
        $group: {
          _id: {
            shareId: "$shareId",
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
      { $group: { _id: { shareId: "$_id.shareId", viewer: "$_id.viewer" }, sessions: { $sum: 1 } } },
      { $match: { sessions: { $gt: 1 } } },
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
          // Time per document, to pair with the pages per document from the view facet.
          perDoc: { $push: { docId: "$_id.docId", readingTimeMs: "$readingTimeMs" } },
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
    // The headline and "documents opened" are the workspace's own question — "did anyone read this,
    // anywhere" — so they count every read, a data room's included. `openedDocIds` also governs the
    // quiet list, and a nudge that says "shared three weeks ago, still unopened" about a file a
    // recipient read in a data room yesterday is the one wrong answer that makes an owner act.
    views += safeCount(row.views);
    openedDocIds.add(docId);
    // The ranked row is document-scoped: it prints a per-document figure and opens that document's
    // metrics page, which excludes project-link reads (`@/lib/analytics/docScope`). A document whose
    // only traffic in the window came through a data room therefore has nothing to show here — its
    // reading is ranked under the project link on the card beside this one.
    const rowViews = safeCount(row.ownViews);
    if (!rowViews) continue;
    const rowViewers = safeCount(row.ownViewers);
    // Opens and reading time are the visit row's, joined by document id. A document with views and
    // no visit row is traffic older than visits — that is what `opensPartial` below reports.
    const visit = opensByDocId.get(docId);
    const rowOpens = safeCount(visit?.ownOpens);
    const rowMs = safeCount(visit?.ownReadingTimeMs);
    topDocCandidates.push({
      docId,
      title: titleOf(docId),
      views: rowViews,
      viewers: rowViewers,
      opens: rowOpens,
      readingTimeMs: rowMs,
      avgReadingTimeMs: avgReadingTimeMs(rowMs, rowViewers),
      lastOpenedAt: toIsoOrNull(row.ownLastSeen),
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

  // Named first, ranked second. The aggregation's `$limit` has already cut this to a page-sized
  // candidate pool, and the order inside it cannot be settled until each row's kind is known: a
  // project link's views are its recipients, not its rows, and only its `ShareLink` says so.
  const linkCandidates = byLink
    .map((row): WorkspaceLinkCandidate | null => {
      const shareId = typeof row?._id === "string" ? row._id : "";
      // Live documents only — the same bound every other figure on this page carries. `viewScope`
      // already restricts the scan to them, so this drops nothing in practice and keeps the row
      // honest if that ever changes.
      const docIds = (row.docIds ?? []).map((d) => String(d)).filter((d) => docById.has(d));
      if (!shareId || !docIds.length) return null;
      // Sorted, so the document a deleted link falls back to is the same one on every request.
      docIds.sort();
      return {
        shareId,
        docIds,
        rows: safeCount(row.rows),
        readers: safeCount(row.readers),
        lastOpenedAt: toIsoOrNull(row.lastSeen),
      };
    })
    .filter((r): r is WorkspaceLinkCandidate => r !== null);

  const linkIdentityByShareId = new Map<string, WorkspaceLinkIdentity>();
  if (linkCandidates.length) {
    const linkDocs = (await ShareLinkModel.find({ orgId, shareId: { $in: linkCandidates.map((l) => l.shareId) } })
      .select({ _id: 1, shareId: 1, label: 1, audience: 1, isDefault: 1, kind: 1, docId: 1, projectId: 1 })
      .lean()) as unknown as Array<{
      _id?: Types.ObjectId;
      shareId?: string;
      label?: unknown;
      audience?: unknown;
      isDefault?: unknown;
      kind?: unknown;
      docId?: Types.ObjectId | null;
      projectId?: Types.ObjectId | null;
    }>;

    // Project names for the project links among them only — one read, and only when there are any.
    const projectIds = linkDocs
      .filter((l) => l.kind === "project" && l.projectId)
      .map((l) => l.projectId as Types.ObjectId);
    const projectNameById = new Map<string, string>();
    if (projectIds.length) {
      const projects = (await ProjectModel.find({ orgId, _id: { $in: projectIds } })
        .select({ _id: 1, name: 1 })
        .lean()) as unknown as Array<{ _id?: Types.ObjectId; name?: unknown }>;
      for (const p of projects) {
        if (!p?._id) continue;
        const name = typeof p.name === "string" ? p.name.trim() : "";
        if (name) projectNameById.set(String(p._id), name);
      }
    }

    for (const link of linkDocs) {
      const shareId = String(link.shareId ?? "");
      if (!shareId) continue;
      const projectId = link.projectId ? String(link.projectId) : null;
      linkIdentityByShareId.set(shareId, {
        shareLinkId: link._id ? String(link._id) : null,
        kind: typeof link.kind === "string" ? link.kind : null,
        label: typeof link.label === "string" ? link.label : null,
        audience: typeof link.audience === "string" ? link.audience : null,
        isDefault: link.isDefault === true,
        docId: link.docId ? String(link.docId) : null,
        projectId,
        projectName: projectId ? (projectNameById.get(projectId) ?? null) : null,
      });
    }
  }

  const rankedLinks: WorkspaceTopLink[] = buildTopLinks(
    linkCandidates,
    (shareId) => linkIdentityByShareId.get(shareId),
    titleOf,
    WORKSPACE_TOP_LINKS_LIMIT,
  );

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

  /**
   * The single reading a person's badge should be about: the document they spent longest in.
   *
   * Pages come from the view rows, time from the visit rows, length from the upload — three
   * sources that only line up per (person, document), which is why both facets keep that grain.
   * A document with no recorded length is still usable: `readingDepth` simply skips the coverage
   * rule, exactly as it does on a document page whose page count is unknown.
   */
  const depthSampleFor = (
    viewRow: PersonRow | undefined,
    visitRow: VisitPersonRow | undefined,
  ): WorkspacePerson["depthSample"] => {
    const pagesByDoc = new Map<string, number>();
    for (const entry of (viewRow?.perDoc ?? []) as Array<{ docId?: unknown; pages?: unknown }>) {
      const docId = entry?.docId ? String(entry.docId) : "";
      const pages = safeCount(entry?.pages);
      if (docId) pagesByDoc.set(docId, pages);
    }
    let best: { docId: string; timeMs: number } | null = null;
    for (const entry of (visitRow?.perDoc ?? []) as Array<{ docId?: unknown; readingTimeMs?: unknown }>) {
      const docId = entry?.docId ? String(entry.docId) : "";
      if (!docId) continue;
      const timeMs = safeCount(entry?.readingTimeMs);
      if (!best || timeMs > best.timeMs) best = { docId, timeMs };
    }
    if (!best || best.timeMs <= 0) return null;
    return {
      docId: best.docId,
      timeMs: best.timeMs,
      pages: pagesByDoc.get(best.docId) ?? 0,
      totalPages: pagesByDocId.get(best.docId) ?? null,
    };
  };

  /**
   * Where a row goes: this person's page for the reading its badge is about.
   *
   * Two guards, because a link that lands on "No reader by that id in this window" is worse than
   * no link. The reading has to have happened on the document's *own* links — a read through a
   * project link belongs to the project, and the document's reader page excludes it by design —
   * and the person has to be addressable, which an anonymous reader is only through the device
   * digest a project key stores with a document appended.
   */
  const readerHrefFor = (viewRow: PersonRow | undefined, sample: WorkspacePerson["depthSample"]): string | null => {
    if (!sample?.docId) return null;
    const entry = ((viewRow?.perDoc ?? []) as Array<{ docId?: unknown; ownReads?: unknown; projectSlug?: unknown }>).find(
      (e) => String(e?.docId ?? "") === sample.docId,
    );
    const userId = viewRow?.viewerUserId ? String(viewRow.viewerUserId) : "";
    const digest = viewRow?.botIdHash ? splitProjectViewerKey(String(viewRow.botIdHash)).botIdHash : "";
    const key = userId ? `u_${userId}` : digest ? `a_${digest}` : null;
    if (!key) return null;
    // Read on the document's own link: the document's reader page holds it.
    if (safeCount(entry?.ownReads)) return `/doc/${encodeURIComponent(sample.docId)}/metrics/viewer/${key}`;
    // Read through a project link: the project's reader page holds it, and the document's would
    // answer "no reader by that id" because it excludes project traffic by design.
    const projectId = entry?.projectSlug ? projectIdBySlug.get(String(entry.projectSlug)) : null;
    return projectId ? `/project/${encodeURIComponent(projectId)}/metrics/viewer/${key}` : null;
  };

  /**
   * Every named person in the window, before either card trims them.
   *
   * Two lists come off this: the engagement ranking ("Most engaged people") and the recency slice
   * the "Recent visitors" strip needs. Built once because they are the same people asked two
   * different questions.
   */
  /**
   * Project link slug -> the project it opens, so a reader who came through one can be sent to the
   * pages that actually hold their reading. Bounded by the workspace's project links.
   */
  const projectIdBySlug = new Map<string, string>();
  if (isPro && projectShareIds.length) {
    const rows = (await ShareLinkModel.find({ orgId, shareId: { $in: projectShareIds } })
      .select({ _id: 0, shareId: 1, projectId: 1 })
      .lean()) as Array<{ shareId?: string; projectId?: unknown }>;
    for (const r of rows) {
      if (r?.shareId && r?.projectId) projectIdBySlug.set(String(r.shareId), String(r.projectId));
    }
  }

  const peopleAll: WorkspacePerson[] = isPro
    ? (() => {
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
              depthSample: (() => depthSampleFor(view, row))(),
              readerHref: (() => {
                const sample = depthSampleFor(view, row);
                return readerHrefFor(view, sample);
              })(),
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
              // No visit rows: their traffic predates the reading clock, so there is no reading to
              // judge and the row carries figures without a word, and nowhere to send a click.
              depthSample: null,
              readerHref: null,
            });
          }
          return rows;
      })()
    : [];
  const people: WorkspacePerson[] = rankPeople(peopleAll, WORKSPACE_PEOPLE_LIMIT);
  /** Newest first, and only people who have actually been seen — a null `lastSeenAt` cannot be recent. */
  const recentPeople: WorkspacePerson[] = [...peopleAll]
    .filter((p) => Boolean(p.lastSeenAt))
    .sort((a, b) => new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime())
    .slice(0, WORKSPACE_RECENT_PEOPLE_LIMIT);

  const firstSharedById = new Map<string, string | null>();
  const lastLiveSharedById = new Map<string, string | null>();
  for (const r of shareLinkDateRows) {
    const docId = r?._id ? String(r._id) : "";
    if (!docId) continue;
    firstSharedById.set(docId, toIsoOrNull(r.firstSharedAt));
    lastLiveSharedById.set(docId, toIsoOrNull(r.lastLiveSharedAt));
  }
  const startIso = start.toISOString();

  // Who did the work, from the activity rows: two bounded reads, and independent of everything
  // above, so it rides along rather than adding a round trip.
  const contributors = await loadContributors({ orgId, start, endExclusive: new Date(now.getTime() + 1) });

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
    people: { count: peopleCount, items: people, recent: recentPeople, gated: !isPro },
    quietDocs,
    output: { docsShared, linksCreated: safeCount(linksCreated), uploads: safeCount(uploads) },
    contributors,
    opensPartial,
    generatedAt: new Date().toISOString(),
  };
}
