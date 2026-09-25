/**
 * Visit briefs: knowing when a visit is over, and writing it up (docs/prds/lnkdrp-visit-briefs.md).
 *
 * The whole feature is here, as functions a cron route calls today and a queue worker can call
 * unchanged later. Three entry points:
 *
 * - `scheduleVisitBrief()` — the ingest hook. Every `POST /api/share/:shareId/stats` upserts one
 *   `VisitBrief` row per sitting with `dueAt = lastEventAt + VISIT_QUIET_MS`. Best-effort, never
 *   throws, one write.
 * - `runVisitBriefs()` — the tick. Recovers stale claims, claims due rows, settles each one
 *   (postpone, skip, recap or brief), enqueues the emails it owes, and sends them in the same tick.
 * - `settleVisitBrief()` — one row, start to finish. Exported so a worker can run exactly this.
 *
 * Why the quiet window is minutes and not seconds: the viewer heartbeats every 30 s while the
 * reader is active, flushes on `pagehide`, and after five idle minutes flushes once more and goes
 * silent. The server cannot tell "quiet for ten seconds" from "between two heartbeats", so two
 * minutes — clear of a heartbeat and the beacon's whole retry backoff — is the shortest honest
 * answer. A closed tab is over two minutes after the close; a tab left open, seven.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { VisitBriefModel, type VisitBrief, type VisitBriefRecapReason, type VisitBriefStatus } from "@/lib/models/VisitBrief";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { recordActivity } from "@/lib/activity/log";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { getAiAutomation } from "@/lib/credits/aiAutomation";
import { failAndRefundLedger, markLedgerCharged, reserveCreditsOrThrow } from "@/lib/credits/creditService";
import { creditsForRun } from "@/lib/credits/schedule";
import { isDailyCapError, isOutOfCreditsError } from "@/lib/credits/errors";
import { enqueueNotifications, notificationDedupeKey } from "@/lib/notifications/queue";
import { drainSlackOutbox, enqueueSlackPosts } from "@/lib/slack/outbox";
import { sendNotificationEmails, type SendNotificationEmailsResult } from "@/lib/notifications/sendNotificationEmails";
import { viewerKeyMatchClause } from "@/lib/share/projectPublic";
import { loadShareViewIdentities, pickReaderIdentity } from "@/lib/share/readerIdentity";
import { dueAtFor, VISIT_QUIET_MS as VISIT_QUIET_MS_LOCAL } from "@/lib/visits/scheduleVisitBrief";
import { generateVisitBrief, type VisitBriefDocument, type VisitBriefRecord } from "@/lib/ai/visitBrief";
import { getPageOutline } from "@/lib/visits/pageOutline";
import { debugError } from "@/lib/debug";

// ---------------------------------------------------------------------------------------------
// Constants (decisions 2, 7 and the retry policy)
// ---------------------------------------------------------------------------------------------

/** A visit with less reading than this gets no brief and no immediate email: it was a glance. */
export const BRIEF_MIN_VISIT_MS = 20 * 1000;
/** …unless it covered at least this many pages, which is a skim rather than a glance. */
export const BRIEF_MIN_PAGES = 2;
/** Briefs a workspace can write in one UTC day; past it the recap goes out without the write-up. */
export const BRIEFS_PER_DAY = 100;
/** A visit still receiving events this long after it started is briefed "so far" rather than never. */
export const MAX_VISIT_OPEN_MS = 6 * 60 * 60 * 1000;
/** A row `generating` this long belongs to a run that died mid-model-call. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
/** Model failures before the row is `failed` and the recap goes out without a brief. */
export const MAX_ATTEMPTS = 3;
/** Wait before retrying a model failure: attempt 1 → 1 min, attempt 2 → 5 min. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000];
/** Rows claimed per tick. Each is a model call, so this is a time budget as much as a batch size. */
export const DEFAULT_CLAIM_LIMIT = 50;
/** Page events kept on the stored snapshot; the prompt uses the reading order, not the raw list. */
export const MAX_STORED_PAGE_EVENTS = 200;
/** Page turns handed to the model. */
const MAX_READING_ORDER = 60;
/** Concurrent model calls per tick. */
const SETTLE_CONCURRENCY = 3;

const BRIEF_ACTION = "brief" as const;
const BRIEF_TIER = "basic" as const;

// The ingest hook lives in `scheduleVisitBrief.ts` so the stats route imports only that; it is
// re-exported here because it is part of this feature's surface.
export { scheduleVisitBrief, dueAtFor, VISIT_QUIET_MS } from "@/lib/visits/scheduleVisitBrief";
export type { ScheduleVisitBriefInput } from "@/lib/visits/scheduleVisitBrief";

// ---------------------------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------------------------

/** Hand back rows a dead run left `generating`. Returns how many. */
export async function recoverStaleVisitBriefClaims(params?: { now?: Date; staleMs?: number }): Promise<number> {
  const now = params?.now ?? new Date();
  const staleMs = params?.staleMs ?? CLAIM_STALE_MS;
  await connectMongo();
  const res = await VisitBriefModel.updateMany(
    { status: "generating", claimedAt: { $lte: new Date(now.getTime() - staleMs) } },
    { $set: { status: "scheduled", dueAt: now, claimedAt: null, claimToken: null } },
  );
  return Number(res.modifiedCount ?? 0);
}

/** Atomically take the due rows, oldest deadline first — the queue's `claimBatch` idiom. */
export async function claimDueVisitBriefs(params: { now: Date; limit: number; dryRun?: boolean; orgId?: Types.ObjectId | null }): Promise<VisitBrief[]> {
  const limit = Math.max(0, Math.floor(params.limit));
  if (!limit) return [];
  await connectMongo();
  const filter: Record<string, unknown> = { status: "scheduled", dueAt: { $lte: params.now } };
  if (params.orgId) filter.orgId = params.orgId;

  if (params.dryRun) {
    return (await VisitBriefModel.find(filter).sort({ dueAt: 1 }).limit(limit).lean()) as unknown as VisitBrief[];
  }
  const candidates = (await VisitBriefModel.find(filter).sort({ dueAt: 1 }).limit(limit).select({ _id: 1 }).lean()) as Array<{ _id: Types.ObjectId }>;
  const ids = candidates.map((c) => c._id);
  if (!ids.length) return [];
  const claimToken = new Types.ObjectId().toHexString();
  await VisitBriefModel.updateMany(
    { ...filter, _id: { $in: ids } },
    { $set: { status: "generating", claimedAt: params.now, claimToken } },
  );
  return (await VisitBriefModel.find({ _id: { $in: ids }, claimToken }).sort({ dueAt: 1 }).lean()) as unknown as VisitBrief[];
}

// ---------------------------------------------------------------------------------------------
// The facts of a sitting
// ---------------------------------------------------------------------------------------------

type LeanVisit = {
  _id: unknown;
  docId: unknown;
  botIdHash: string;
  visitIdHash: string;
  startedAt: Date;
  lastEventAt: Date;
  timeSpentMs?: number;
  pagesSeen?: number[];
  pageTimeMsByPage?: Map<string, number> | Record<string, number>;
  pageVisitCountByPage?: Map<string, number> | Record<string, number>;
  pageEvents?: Array<{ pageNumber: number; enteredAt: Date; leftAt: Date; durationMs: number; reason?: string | null; toPage?: number | null }>;
  pageCount?: number | null;
  isOwnerPreview?: boolean;
  viewerUserId?: unknown;
  viewerName?: string | null;
  viewerEmail?: string | null;
  viewerEmailSnapshot?: string | null;
};

/**
 *
 */
function mapEntries(m: Map<string, number> | Record<string, number> | undefined | null): Array<[number, number]> {
  if (!m) return [];
  const entries = m instanceof Map ? Array.from(m.entries()) : Object.entries(m);
  return entries
    .map(([k, v]): [number, number] => [Number(k), Number(v) || 0])
    .filter(([k]) => Number.isFinite(k) && k >= 1)
    .sort((a, b) => a[0] - b[0]);
}

/** Every `ShareVisit` row of one sitting: one for a document link, one per document for a data room. */
export async function loadSittingVisits(shareId: string, visitIdHash: string): Promise<LeanVisit[]> {
  await connectMongo();
  return (await ShareVisitModel.find({ shareId, visitIdHash }).sort({ startedAt: 1 }).lean()) as unknown as LeanVisit[];
}

/** `YYYY-MM-DD` keys of `downloadsByDay` between two instants, inclusive. */
export function utcDayKeysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = to.getTime();
  while (d.getTime() <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export type SittingStats = NonNullable<VisitBrief["stats"]>;

/**
 * A reader's downloads of one document on this link: the instants when the row has them, and the
 * per-day counts every row has.
 *
 * The instants (`ShareView.downloadedAt`) are what attribute a download to a *sitting*. The by-day
 * map is the fallback for rows written before they were recorded, and it is the reason two
 * same-day sittings both used to say "then downloaded the deck".
 */
export type ReaderDownloads = { byDay: ReadonlyArray<[string, number]>; at: ReadonlyArray<Date> };

/**
 * A download after the last page event still belongs to the sitting when it lands inside the quiet
 * window: "read it, clicked download, closed the tab" writes the download after the final flush.
 */
export const DOWNLOAD_ATTRIBUTION_SLACK_MS = VISIT_QUIET_MS_LOCAL;

/** Downloads by this reader of this document that belong to a sitting, given when it ran. */
export function downloadsDuringSitting(
  downloads: ReaderDownloads | ReadonlyArray<[string, number]> | undefined,
  window: { startedAt: Date; endedAt: Date },
): number {
  if (!downloads) return 0;
  const isRecord = (d: ReaderDownloads | ReadonlyArray<[string, number]>): d is ReaderDownloads => !Array.isArray(d);
  const byDay: ReadonlyArray<[string, number]> = isRecord(downloads) ? downloads.byDay : downloads;
  const at: ReadonlyArray<Date> = isRecord(downloads) ? downloads.at : [];
  if (at.length) {
    const from = window.startedAt.getTime();
    const to = window.endedAt.getTime() + DOWNLOAD_ATTRIBUTION_SLACK_MS;
    return at.filter((d) => d instanceof Date && d.getTime() >= from && d.getTime() <= to).length;
  }
  const dayKeys = new Set(utcDayKeysBetween(window.startedAt, window.endedAt));
  return byDay.filter(([day]) => dayKeys.has(day)).reduce((n, [, c]) => n + c, 0);
}

/**
 * Freeze the sitting into the snapshot the brief and the email read.
 *
 * Pure over the rows it is given, so a test can hand it visits and views without a database.
 */
export function buildSittingStats(params: {
  visits: readonly LeanVisit[];
  titles: ReadonlyMap<string, string>;
  /** The document's own page count, for visits whose viewer never reported one. */
  pageCounts?: ReadonlyMap<string, number>;
  /** This reader's downloads per document (`ShareView.downloadedAt` and `downloadsByDay`); a bare by-day list still works. */
  downloadsByDoc: ReadonlyMap<string, ReaderDownloads | Array<[string, number]>>;
  /** Earlier sittings by the same reader on this link, newest first, already grouped by visit. */
  previousSittings: readonly { startedAt: Date; timeSpentMs: number; pageTimeMs: Array<[number, number]> }[];
}): SittingStats {
  const startedAt = params.visits.reduce((min, v) => (v.startedAt < min ? v.startedAt : min), params.visits[0]!.startedAt);
  const endedAt = params.visits.reduce((max, v) => (v.lastEventAt > max ? v.lastEventAt : max), params.visits[0]!.lastEventAt);

  const docs = params.visits.map((v) => {
    const docId = String(v.docId);
    const downloads = downloadsDuringSitting(params.downloadsByDoc.get(docId), { startedAt, endedAt });
    const events = (v.pageEvents ?? []).slice(-MAX_STORED_PAGE_EVENTS);
    return {
      docId: new Types.ObjectId(docId),
      title: params.titles.get(docId) ?? null,
      timeSpentMs: Math.max(0, Number(v.timeSpentMs) || 0),
      pagesSeen: Array.from(new Set((v.pagesSeen ?? []).map(Number).filter((n) => Number.isFinite(n) && n >= 1))).sort((a, b) => a - b),
      pageCount:
        typeof v.pageCount === "number" && v.pageCount > 0
          ? v.pageCount
          : (params.pageCounts?.get(docId) ?? null),
      pageTimeMsByPage: new Map(mapEntries(v.pageTimeMsByPage).map(([k, ms]) => [String(k), ms])),
      pageVisitCountByPage: new Map(mapEntries(v.pageVisitCountByPage).map(([k, n]) => [String(k), n])),
      pageEvents: events.map((e) => ({
        pageNumber: e.pageNumber,
        enteredAt: e.enteredAt,
        leftAt: e.leftAt,
        durationMs: e.durationMs,
        reason: e.reason ?? null,
        toPage: e.toPage ?? null,
      })),
      downloads,
    };
  });

  const last = params.previousSittings[0] ?? null;
  return {
    timeSpentMs: docs.reduce((n, d) => n + d.timeSpentMs, 0),
    pagesSeen: docs.reduce((n, d) => n + d.pagesSeen.length, 0),
    pageCount: docs.every((d) => d.pageCount) ? docs.reduce((n, d) => n + (d.pageCount ?? 0), 0) : null,
    downloads: docs.reduce((n, d) => n + d.downloads, 0),
    visitNumber: params.previousSittings.length + 1,
    docs,
    previous: last
      ? {
          priorVisits: params.previousSittings.length,
          lastVisitStartedAt: last.startedAt,
          lastVisitTimeSpentMs: last.timeSpentMs,
          lastVisitTopPages: [...last.pageTimeMs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p),
        }
      : null,
  } as SittingStats;
}

/** Below the minimum: a glance, not a read (decision 7). */
export function isBelowMinimum(stats: Pick<SittingStats, "timeSpentMs" | "pagesSeen">): boolean {
  return stats.timeSpentMs < BRIEF_MIN_VISIT_MS && stats.pagesSeen < BRIEF_MIN_PAGES;
}

/** Earlier sittings by this reader on this link, newest first. */
async function loadPreviousSittings(params: { shareId: string; botIdHash: string; visitIdHash: string; before: Date }) {
  const rows = (await ShareVisitModel.find({
    shareId: params.shareId,
    $or: viewerKeyMatchClause(params.botIdHash),
    visitIdHash: { $ne: params.visitIdHash },
    startedAt: { $lt: params.before },
  })
    .sort({ startedAt: -1 })
    .limit(60)
    .select({ visitIdHash: 1, startedAt: 1, timeSpentMs: 1, pageTimeMsByPage: 1 })
    .lean()) as unknown as Array<Pick<LeanVisit, "visitIdHash" | "startedAt" | "timeSpentMs" | "pageTimeMsByPage">>;
  const byVisit = new Map<string, { startedAt: Date; timeSpentMs: number; pageTimeMs: Array<[number, number]> }>();
  for (const r of rows) {
    const cur = byVisit.get(r.visitIdHash);
    const pageTimeMs = mapEntries(r.pageTimeMsByPage);
    if (!cur) {
      byVisit.set(r.visitIdHash, { startedAt: r.startedAt, timeSpentMs: Number(r.timeSpentMs) || 0, pageTimeMs });
    } else {
      cur.startedAt = r.startedAt < cur.startedAt ? r.startedAt : cur.startedAt;
      cur.timeSpentMs += Number(r.timeSpentMs) || 0;
      cur.pageTimeMs = cur.pageTimeMs.concat(pageTimeMs);
    }
  }
  return Array.from(byVisit.values()).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/**
 *
 */
async function loadDownloadsByDoc(shareId: string, botIdHash: string): Promise<Map<string, ReaderDownloads>> {
  const rows = (await ShareViewModel.find({ shareId, $or: viewerKeyMatchClause(botIdHash) })
    .select({ docId: 1, downloadsByDay: 1, downloadedAt: 1 })
    .lean()) as unknown as Array<{ docId: unknown; downloadsByDay?: Map<string, number> | Record<string, number>; downloadedAt?: unknown[] }>;
  const out = new Map<string, ReaderDownloads>();
  for (const r of rows) {
    const m = r.downloadsByDay;
    const entries = !m ? [] : m instanceof Map ? Array.from(m.entries()) : Object.entries(m);
    out.set(String(r.docId), {
      byDay: entries.map(([k, v]): [string, number] => [String(k), Number(v) || 0]),
      at: (Array.isArray(r.downloadedAt) ? r.downloadedAt : []).map((d) => (d instanceof Date ? d : new Date(String(d)))).filter((d) => Number.isFinite(d.getTime())),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The record the model reads
// ---------------------------------------------------------------------------------------------

type LinkInfo = { label: string | null; audience: string | null; isDefault: boolean; kind: "document" | "project"; projectId: string | null; docId: string | null };

/**
 *
 */
async function loadLink(shareId: string): Promise<LinkInfo | null> {
  const link = (await ShareLinkModel.findOne({ shareId }).select({ label: 1, audience: 1, isDefault: 1, docId: 1, projectId: 1 }).lean()) as
    | { label?: string; audience?: string | null; isDefault?: boolean; docId?: unknown; projectId?: unknown }
    | null;
  if (!link) return null;
  return {
    label: typeof link.label === "string" ? link.label : null,
    audience: typeof link.audience === "string" ? link.audience : null,
    isDefault: Boolean(link.isDefault),
    kind: link.projectId ? "project" : "document",
    projectId: link.projectId ? String(link.projectId) : null,
    docId: link.docId ? String(link.docId) : null,
  };
}

/** Seconds a person would say: whole seconds, never milliseconds. */
function seconds(ms: number): number {
  return Math.round(Math.max(0, ms) / 1000);
}

/**
 *
 */
export function buildVisitBriefRecord(params: {
  row: Pick<VisitBrief, "startedAt" | "lastEventAt" | "viewerName" | "viewerEmail" | "viewerUserId">;
  stats: SittingStats;
  link: LinkInfo | null;
  viewerAccountName: string | null;
  outlineByDoc: ReadonlyMap<string, Array<{ pageNumber: number; heading: string | null; excerpt: string | null; text?: string | null }>>;
}): VisitBriefRecord {
  const { row, stats } = params;
  const documents: VisitBriefDocument[] = stats.docs.map((d) => {
    const title = d.title ?? "Untitled";
    const time = mapEntries(d.pageTimeMsByPage as unknown as Map<string, number>);
    const opened = new Map(mapEntries(d.pageVisitCountByPage as unknown as Map<string, number>));
    const firstSeen = new Map<number, number>();
    d.pageEvents.forEach((e, i) => {
      if (!firstSeen.has(e.pageNumber)) firstSeen.set(e.pageNumber, i);
    });
    const pages = d.pagesSeen
      .map((p) => ({ page: p, seconds: seconds(time.find(([k]) => k === p)?.[1] ?? 0), opened: Math.max(1, opened.get(p) ?? 1) }))
      .sort((a, b) => (firstSeen.get(a.page) ?? 1e9) - (firstSeen.get(b.page) ?? 1e9));
    const readingOrder: number[] = [];
    for (const e of d.pageEvents) {
      if (readingOrder[readingOrder.length - 1] !== e.pageNumber) readingOrder.push(e.pageNumber);
      if (e.toPage && readingOrder[readingOrder.length - 1] !== e.toPage) readingOrder.push(e.toPage);
    }
    const seen = new Set(d.pagesSeen);
    const never = d.pageCount ? Array.from({ length: d.pageCount }, (_, i) => i + 1).filter((p) => !seen.has(p)) : [];
    return {
      title,
      pageCount: typeof d.pageCount === "number" ? d.pageCount : null,
      pages,
      readingOrder: readingOrder.slice(0, MAX_READING_ORDER),
      pagesNeverOpened: never,
      downloads: d.downloads,
      totalSeconds: seconds(d.timeSpentMs),
    };
  });

  const outline: Record<string, Array<{ page: number; heading: string | null; excerpt: string | null; text?: string | null }>> = {};
  for (const d of stats.docs) {
    const entries = params.outlineByDoc.get(String(d.docId));
    if (!entries?.length) continue;
    // Only the pages the model will talk about: seen ones plus the never-opened list's first few,
    // so a 200-page report does not put 200 lines in the prompt for a six-page read.
    const wanted = new Set<number>(d.pagesSeen);
    const never = d.pageCount ? Array.from({ length: d.pageCount }, (_, i) => i + 1).filter((p) => !wanted.has(p)).slice(0, 12) : [];
    for (const p of never) wanted.add(p);
    // The focus pages get their whole text: the three that held the reader longest, and any they
    // came back to. That is what lets the brief say what was *on* the page that held them.
    const time = mapEntries(d.pageTimeMsByPage as unknown as Map<string, number>);
    const opened = mapEntries(d.pageVisitCountByPage as unknown as Map<string, number>);
    const focus = new Set<number>([
      ...[...time].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, ms]) => ms >= 5_000).map(([p]) => p),
      ...opened.filter(([, n]) => n > 1).map(([p]) => p),
    ]);
    outline[d.title ?? "Untitled"] = entries
      .filter((e) => wanted.has(e.pageNumber))
      .map((e) => ({
        page: e.pageNumber,
        heading: e.heading,
        excerpt: e.excerpt,
        ...(focus.has(e.pageNumber) && e.text ? { text: e.text } : {}),
      }));
  }

  const name = row.viewerName ?? params.viewerAccountName ?? null;
  return {
    link: params.link
      ? { label: params.link.isDefault ? null : params.link.label, audience: params.link.audience, isDefault: params.link.isDefault, kind: params.link.kind }
      : { label: null, audience: null, isDefault: true, kind: stats.docs.length > 1 ? "project" : "document" },
    viewer: {
      name,
      email: row.viewerEmail ?? null,
      source: row.viewerUserId ? "account" : row.viewerName || row.viewerEmail ? "volunteered" : "unknown",
    },
    visit: {
      startedAt: row.startedAt.toISOString(),
      endedAt: row.lastEventAt.toISOString(),
      totalSeconds: seconds(stats.timeSpentMs),
      ...(stats.visitNumber > 1 ? { visitNumber: stats.visitNumber } : {}),
      documents,
    },
    outline: Object.keys(outline).length ? outline : null,
    previous: stats.previous
      ? {
          priorVisits: stats.previous.priorVisits,
          lastVisitStartedAt: stats.previous.lastVisitStartedAt ? stats.previous.lastVisitStartedAt.toISOString() : null,
          lastVisitTotalSeconds: typeof stats.previous.lastVisitTimeSpentMs === "number" ? seconds(stats.previous.lastVisitTimeSpentMs) : null,
          lastVisitTopPages: stats.previous.lastVisitTopPages ?? [],
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Settling one row
// ---------------------------------------------------------------------------------------------

export type SettleOutcome = "postponed" | "skipped" | "recap" | "briefed" | "retry" | "failed";

export type SettleResult = { outcome: SettleOutcome; reason?: VisitBriefRecapReason | "not_quiet" | "visit_missing"; creditsCharged: number };

/** Who a workspace's automatic runs are billed to: the owner, else whoever created the org. */
async function resolveBillingUserId(orgId: Types.ObjectId): Promise<string | null> {
  const owner = (await OrgMembershipModel.findOne({ orgId, role: "owner", isDeleted: { $ne: true } }).select({ userId: 1 }).lean()) as { userId?: unknown } | null;
  if (owner?.userId) return String(owner.userId);
  const org = (await OrgModel.findById(orgId).select({ createdByUserId: 1 }).lean()) as { createdByUserId?: unknown } | null;
  return org?.createdByUserId ? String(org.createdByUserId) : null;
}

/**
 *
 */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 *
 */
async function briefsWrittenToday(orgId: Types.ObjectId, now: Date): Promise<number> {
  return VisitBriefModel.countDocuments({ orgId, status: "briefed", closedAt: { $gte: startOfUtcDay(now) } });
}

/** One `credits.exhausted` feed row per workspace per UTC day for briefs, not one per visit. */
async function noteCreditsExhaustedOnce(params: { orgId: Types.ObjectId; docId: string | null; projectId: string | null; title: string | null; now: Date; code: string }) {
  const already = await ActivityEventModel.exists({
    orgId: params.orgId,
    type: "credits.exhausted",
    "meta.source": "brief",
    createdDate: { $gte: startOfUtcDay(params.now) },
  });
  if (already) return;
  await recordActivity({
    orgId: params.orgId,
    userId: null,
    actorKind: "viewer",
    agent: null,
    type: "credits.exhausted",
    docId: params.docId,
    projectId: params.projectId,
    title: params.title,
    meta: { source: "brief", code: params.code, creditsNeeded: creditsForRun({ actionType: BRIEF_ACTION, qualityTier: BRIEF_TIER }) },
  });
}

type ClaimedRow = VisitBrief & { _id: Types.ObjectId };

/**
 *
 */
async function finish(row: ClaimedRow, set: Record<string, unknown>): Promise<void> {
  await VisitBriefModel.updateOne({ _id: row._id, claimToken: row.claimToken }, { $set: { ...set, claimedAt: null, claimToken: null } });
}

export { pickReaderIdentity };

/** The name on the reader's account, when they were signed in; the brief prefers it to "Someone". */
async function loadAccountName(viewerUserId: unknown): Promise<string | null> {
  if (!viewerUserId || !Types.ObjectId.isValid(String(viewerUserId))) return null;
  const u = (await UserModel.findById(viewerUserId).select({ name: 1, email: 1 }).lean()) as { name?: string; email?: string } | null;
  const name = typeof u?.name === "string" ? u.name.trim() : "";
  return name || (typeof u?.email === "string" ? u.email.trim() : "") || null;
}

/**
 * Take one claimed row from "the visit might be over" to its terminal state.
 *
 * Order matters and is the PRD's: not quiet → postpone; owner preview / glance → skip (nothing
 * sent); not Pro / auto off / daily cap / out of credits → recap (the facts go out, no write-up);
 * else reserve, generate, charge, store → brief. Every exit past "skipped" enqueues the emails.
 */
export async function settleVisitBrief(row: ClaimedRow, params: { now: Date; dryRun?: boolean }): Promise<SettleResult> {
  const { now } = params;
  const dryRun = Boolean(params.dryRun);
  const visits = await loadSittingVisits(row.shareId, row.visitIdHash);

  // The ingest writes `ShareVisit` and then this row, so a missing visit is a write that failed
  // or a heartbeat with no timing yet. Look again later; give up when the visit would be stale.
  if (!visits.length) {
    if (now.getTime() - row.startedAt.getTime() > MAX_VISIT_OPEN_MS) {
      if (!dryRun) await finish(row, { status: "skipped", recapReason: "below_minimum", closedAt: now });
      return { outcome: "skipped", reason: "visit_missing", creditsCharged: 0 };
    }
    if (!dryRun) await finish(row, { status: "scheduled", dueAt: dueAtFor(now) });
    return { outcome: "postponed", reason: "visit_missing", creditsCharged: 0 };
  }

  const latest = visits.reduce((max, v) => (v.lastEventAt > max ? v.lastEventAt : max), visits[0]!.lastEventAt);
  const earliest = visits.reduce((min, v) => (v.startedAt < min ? v.startedAt : min), visits[0]!.startedAt);
  const stillOpen = now.getTime() - earliest.getTime() < MAX_VISIT_OPEN_MS;
  if (dueAtFor(latest).getTime() > now.getTime() && stillOpen) {
    // The reader came back. Same row, later deadline; nothing else changes.
    if (!dryRun) await finish(row, { status: "scheduled", lastEventAt: latest, dueAt: dueAtFor(latest) });
    return { outcome: "postponed", reason: "not_quiet", creditsCharged: 0 };
  }

  // The visit is over. Freeze the facts before any gate, so a recap has as much as a brief.
  const docIds = Array.from(new Set(visits.map((v) => String(v.docId))));
  const docs = (await DocModel.find({ _id: { $in: docIds.map((id) => new Types.ObjectId(id)) } })
    .select({ _id: 1, title: 1, isDeleted: 1, isArchived: 1, "slideNodes.pageNumber": 1 })
    .lean()) as Array<{ _id: unknown; title?: string; isDeleted?: boolean; isArchived?: boolean; slideNodes?: unknown[] }>;
  const titles = new Map(docs.map((d) => [String(d._id), typeof d.title === "string" && d.title.trim() ? d.title.trim() : "Untitled"]));
  // The viewer reports `numPages` on every timing post, but a row written by an older viewer (or the
  // traffic harness) has none; the document knows how long it is either way.
  const pageCounts = new Map(
    docs
      .filter((d) => Array.isArray(d.slideNodes) && d.slideNodes.length > 0)
      .map((d) => [String(d._id), (d.slideNodes as unknown[]).length] as [string, number]),
  );
  const previousSittings = await loadPreviousSittings({ shareId: row.shareId, botIdHash: row.botIdHash, visitIdHash: row.visitIdHash, before: earliest });
  const downloadsByDoc = await loadDownloadsByDoc(row.shareId, row.botIdHash);
  const stats = buildSittingStats({ visits, titles, pageCounts, downloadsByDoc, previousSittings });
  const ownerPreview = Boolean(row.isOwnerPreview) || visits.some((v) => v.isOwnerPreview);
  // A data-room reader introduces themselves once on the landing page, and that lands on the
  // link's ShareView rows, never on this row (the viewer's timing posts carry no name). Without
  // this the brief, its email and its Slack post said "Someone" for every document the reader
  // opened after introducing themselves, while the open email named them. Filled here, once, so
  // the row itself carries the reader and every surface reads the same name.
  const identity = pickReaderIdentity(row, await loadShareViewIdentities(row.shareId, row.botIdHash));
  Object.assign(row, identity);
  const base = { lastEventAt: latest, startedAt: earliest, stats, closedAt: now, ...identity };

  if (ownerPreview) {
    if (!dryRun) await finish(row, { ...base, status: "skipped", recapReason: "owner_preview" });
    return { outcome: "skipped", reason: "owner_preview", creditsCharged: 0 };
  }
  if (isBelowMinimum(stats)) {
    if (!dryRun) await finish(row, { ...base, status: "skipped", recapReason: "below_minimum" });
    return { outcome: "skipped", reason: "below_minimum", creditsCharged: 0 };
  }
  // Every document of the sitting gone: nothing to link to, nobody to tell.
  if (!docs.some((d) => !d.isDeleted && !d.isArchived)) {
    if (!dryRun) await finish(row, { ...base, status: "skipped", recapReason: "below_minimum" });
    return { outcome: "skipped", reason: "below_minimum", creditsCharged: 0 };
  }

  const link = await loadLink(row.shareId);
  const { title, docId, projectId } = describeSitting(row, stats);

  /** The recap exits: the visit is written up in facts, the email goes, no credit moves. */
  const recap = async (reason: VisitBriefRecapReason): Promise<SettleResult> => {
    if (!dryRun) {
      await finish(row, { ...base, status: "recap", recapReason: reason });
      await announceAndEnqueue({ row, stats, link, title, docId, projectId, headline: null, reason, now });
    }
    return { outcome: "recap", reason, creditsCharged: 0 };
  };

  let plan: "free" | "pro" = "free";
  try {
    plan = (await getWorkspacePlan(row.orgId)) === "pro" ? "pro" : "free";
  } catch (err) {
    debugError(1, "[visit-briefs] plan lookup failed; treating as free", { orgId: String(row.orgId), message: err instanceof Error ? err.message : String(err) });
  }
  if (plan !== "pro") {
    // Decision 8: Free gets nothing here; its open email carries the Pro line.
    if (!dryRun) await finish(row, { ...base, status: "skipped", recapReason: "plan" });
    return { outcome: "skipped", reason: "plan", creditsCharged: 0 };
  }
  if (!(await getAiAutomation(row.orgId)).brief) return recap("auto_off");
  if ((await briefsWrittenToday(row.orgId, now)) >= BRIEFS_PER_DAY) return recap("daily_cap");

  if (dryRun) return { outcome: "briefed", creditsCharged: 0 };

  // ---- Reserve, generate, charge ------------------------------------------------------------
  const billingUserId = await resolveBillingUserId(row.orgId);
  if (!billingUserId) return recap("out_of_credits");
  const written = await generateAndStoreBrief({
    row,
    stats,
    link,
    title,
    docId,
    projectId,
    billingUserId,
    // Per row and per attempt: a refunded reservation must not be handed back on the retry.
    idempotencyKey: `brief:${String(row._id)}:${row.attempts}`,
    base,
    now,
  });
  if (written.ok) return { outcome: "briefed", creditsCharged: written.creditsCharged };
  if (written.kind === "daily_cap") {
    await noteCreditsExhaustedOnce({ orgId: row.orgId, docId, projectId, title, now, code: "daily_cap" });
    return recap("daily_cap");
  }
  if (written.kind === "out_of_credits") {
    await noteCreditsExhaustedOnce({ orgId: row.orgId, docId, projectId, title, now, code: "out_of_credits" });
    return recap("out_of_credits");
  }
  const attempts = (row.attempts ?? 0) + 1;
  const message = written.kind === "model_failed" ? written.message : "";
  if (attempts >= MAX_ATTEMPTS) {
    await finish(row, { ...base, status: "failed", recapReason: "model_failed", attempts, lastError: message.slice(0, 500) });
    await announceAndEnqueue({ row, stats, link, title, docId, projectId, headline: null, reason: "model_failed", now });
    return { outcome: "failed", reason: "model_failed", creditsCharged: 0 };
  }
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
  await finish(row, { ...base, status: "scheduled", attempts, lastError: message.slice(0, 500), dueAt: new Date(now.getTime() + backoff) });
  return { outcome: "retry", reason: "model_failed", creditsCharged: 0 };
}

// ---------------------------------------------------------------------------------------------
// Writing the brief: the cron and the "Write the brief" button share this
// ---------------------------------------------------------------------------------------------

type GenerateAndStoreResult =
  | { ok: true; headline: string; creditsCharged: number }
  | { ok: false; kind: "out_of_credits" | "daily_cap" }
  | { ok: false; kind: "model_failed"; message: string };

/** What the sitting is about, for the feed row, the ledger and the email: one document, or the room. */
function describeSitting(row: Pick<VisitBrief, "docId" | "projectId">, stats: SittingStats): { title: string | null; docId: string | null; projectId: string | null } {
  const firstDoc = stats.docs[0];
  return {
    title: stats.docs.length === 1 ? (firstDoc?.title ?? null) : null,
    projectId: row.projectId ? String(row.projectId) : null,
    docId: row.docId ? String(row.docId) : stats.docs.length === 1 && firstDoc ? String(firstDoc.docId) : null,
  };
}

/**
 * Reserve one credit, call the model, charge with usage, store the brief and announce it.
 *
 * The row must be claimed (`claimToken` set) so `finish` lands on the row this run holds. On a
 * refused reservation nothing is written and the caller decides between recap and 402; on a model
 * failure the reservation is refunded and the row is left for the caller to retry, fail or unclaim.
 * `announce.email` is false for a manual write: the recap email for this visit already went, and
 * the person who clicked is looking at the result.
 */
async function generateAndStoreBrief(params: {
  row: ClaimedRow;
  stats: SittingStats;
  link: LinkInfo | null;
  title: string | null;
  docId: string | null;
  projectId: string | null;
  billingUserId: string;
  idempotencyKey: string;
  /** Fields every terminal write carries (the frozen facts, `closedAt`). */
  base: Record<string, unknown>;
  now: Date;
  email?: boolean;
}): Promise<GenerateAndStoreResult> {
  const { row, stats, link, title, docId, projectId, now } = params;
  const credits = creditsForRun({ actionType: BRIEF_ACTION, qualityTier: BRIEF_TIER });
  let ledgerId: string | null = null;
  try {
    const reserved = await reserveCreditsOrThrow({
      workspaceId: String(row.orgId),
      userId: params.billingUserId,
      docId,
      actionType: BRIEF_ACTION,
      qualityTier: BRIEF_TIER,
      idempotencyKey: params.idempotencyKey,
    });
    ledgerId = reserved.ledgerId;
  } catch (err) {
    if (isDailyCapError(err)) return { ok: false, kind: "daily_cap" };
    if (isOutOfCreditsError(err) || /insufficient credits|limit exceeded|cap exceeded/i.test(err instanceof Error ? err.message : String(err))) {
      return { ok: false, kind: "out_of_credits" };
    }
    throw err;
  }

  try {
    const outlineByDoc = new Map<string, Array<{ pageNumber: number; heading: string | null; excerpt: string | null; text?: string | null }>>();
    for (const d of stats.docs) {
      const outline = await getPageOutline(d.docId);
      if (outline) outlineByDoc.set(String(d.docId), outline);
    }
    const record = buildVisitBriefRecord({ row, stats, link, viewerAccountName: await loadAccountName(row.viewerUserId), outlineByDoc });
    const result = await generateVisitBrief({ record, meta: { userId: params.billingUserId, docId, projectId } });
    result.output.headline = strongerHeadline({
      headline: result.output.headline,
      interests: result.output.interests,
      stats,
      documentShort: documentShortName(title ?? (stats.docs.length > 1 ? "data room" : null)),
    });

    await markLedgerCharged({ workspaceId: String(row.orgId), ledgerId, creditsCharged: credits, telemetry: result.telemetry });
    await finish(row, {
      ...params.base,
      status: "briefed",
      recapReason: null,
      brief: {
        headline: result.output.headline,
        body: result.output.body,
        interests: result.output.interests,
        highlights: result.output.highlights,
        followUp: result.output.followUp,
        model: result.telemetry.modelRoute,
        tokensIn: result.telemetry.promptTokens,
        tokensOut: result.telemetry.completionTokens,
        latencyMs: result.telemetry.latencyMs,
      },
      ledgerId: new Types.ObjectId(ledgerId),
      aiRunId: result.aiRunId && Types.ObjectId.isValid(result.aiRunId) ? new Types.ObjectId(result.aiRunId) : null,
      lastError: null,
    });
    await announceAndEnqueue({ row, stats, link, title, docId, projectId, headline: result.output.headline, reason: null, now, email: params.email ?? true });
    return { ok: true, headline: result.output.headline, creditsCharged: credits };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await failAndRefundLedger({ workspaceId: String(row.orgId), ledgerId });
    } catch (refundErr) {
      debugError(1, "[visit-briefs] refund failed", { ledgerId, message: refundErr instanceof Error ? refundErr.message : String(refundErr) });
    }
    return { ok: false, kind: "model_failed", message };
  }
}

export type WriteVisitBriefNowResult =
  /** Written; `card` is what the reader page shows. */
  | { status: "briefed"; card: VisitBriefCard; creditsCharged: number }
  /** No such row in this workspace. */
  | { status: "not_found" }
  /** Not a recap or a failed visit: already briefed, still open, skipped, or being written right now. */
  | { status: "conflict"; current: VisitBriefStatus }
  /** Free workspace: briefs are a Pro feature (decision 8). */
  | { status: "plan" }
  | { status: "out_of_credits" }
  | { status: "daily_cap" }
  | { status: "model_failed" };

/**
 * The "Write the brief" button: a member asks for the brief a recap or failed visit never got.
 *
 * Same reserve/generate/charge/store as the cron, billed to the member who clicked, and past the
 * automatic-briefs and per-day gates on purpose - those exist so credits are not spent without a
 * click, and this is the click. The credit gates still apply (402s). The row is claimed first, so a
 * double click or a concurrent cron cannot write it twice; a model failure hands the row back to
 * its previous state with `lastError` set, so the button stays.
 */
export async function writeVisitBriefNow(params: { visitBriefId: string; orgId: string; userId: string; now?: Date }): Promise<WriteVisitBriefNowResult> {
  const now = params.now ?? new Date();
  if (!Types.ObjectId.isValid(params.visitBriefId) || !Types.ObjectId.isValid(params.orgId)) return { status: "not_found" };
  await connectMongo();
  const orgId = new Types.ObjectId(params.orgId);
  const existing = (await VisitBriefModel.findOne({ _id: new Types.ObjectId(params.visitBriefId), orgId }).lean()) as ClaimedRow | null;
  if (!existing) return { status: "not_found" };
  if (existing.status !== "recap" && existing.status !== "failed") return { status: "conflict", current: existing.status };
  if (!existing.stats) return { status: "conflict", current: existing.status };

  if ((await getWorkspacePlan(orgId)) !== "pro") return { status: "plan" };

  const claimToken = `manual:${String(params.userId)}:${now.getTime()}`;
  const claimed = (await VisitBriefModel.findOneAndUpdate(
    { _id: existing._id, status: existing.status, claimToken: null },
    { $set: { status: "generating", claimedAt: now, claimToken } },
    { new: true },
  ).lean()) as ClaimedRow | null;
  if (!claimed) return { status: "conflict", current: "generating" };

  const stats = claimed.stats as SittingStats;
  const link = await loadLink(claimed.shareId);
  const { title, docId, projectId } = describeSitting(claimed, stats);
  const attempts = (claimed.attempts ?? 0) + 1;
  const written = await generateAndStoreBrief({
    row: claimed,
    stats,
    link,
    title,
    docId,
    projectId,
    billingUserId: params.userId,
    idempotencyKey: `brief:${String(claimed._id)}:manual:${attempts}`,
    // The facts were frozen when the visit closed; only the attempt count moves.
    base: { attempts },
    now,
    email: false,
  });
  if (written.ok) {
    const fresh = (await VisitBriefModel.findById(claimed._id).lean()) as ClaimedRow | null;
    return { status: "briefed", card: visitBriefCard(fresh ?? claimed), creditsCharged: written.creditsCharged };
  }
  // Hand the row back as it was, so the button is still there.
  await finish(claimed, {
    status: existing.status,
    attempts,
    ...(written.kind === "model_failed" ? { lastError: written.message.slice(0, 500) } : {}),
  });
  return { status: written.kind };
}

// ---------------------------------------------------------------------------------------------
// The card: what the reader page and the MCP show for one sitting
// ---------------------------------------------------------------------------------------------

export type VisitBriefCard = {
  id: string;
  status: Extract<VisitBriefStatus, "briefed" | "recap" | "failed">;
  recapReason: VisitBriefRecapReason | null;
  shareId: string;
  docId: string | null;
  projectId: string | null;
  viewerKey: string;
  viewerUserId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
  startedAt: string;
  endedAt: string;
  closedAt: string | null;
  timeSpentMs: number;
  pagesSeen: number;
  pageCount: number | null;
  downloads: number;
  visitNumber: number;
  docs: Array<{ docId: string; title: string | null; timeSpentMs: number; pagesSeen: number[]; pageCount: number | null; downloads: number }>;
  brief: { headline: string; body: string; interests: string[]; highlights: string[]; followUp: string | null } | null;
  /** A recap or a failed visit can be written on demand for one credit. */
  canWrite: boolean;
};

/** The statuses a card exists for: a visit that closed with something to say. Skipped visits have nothing. */
export const VISIT_BRIEF_CARD_STATUSES = ["briefed", "recap", "failed"] as const;

/**
 *
 */
export function visitBriefCard(row: VisitBrief & { _id: Types.ObjectId }): VisitBriefCard {
  const stats = row.stats;
  const status = (row.status === "briefed" || row.status === "recap" || row.status === "failed" ? row.status : "recap") as VisitBriefCard["status"];
  return {
    id: String(row._id),
    status,
    recapReason: row.recapReason ?? null,
    shareId: row.shareId,
    docId: row.docId ? String(row.docId) : null,
    projectId: row.projectId ? String(row.projectId) : null,
    viewerKey: row.botIdHash,
    viewerUserId: row.viewerUserId ? String(row.viewerUserId) : null,
    viewerName: row.viewerName ?? null,
    viewerEmail: row.viewerEmail ?? null,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.lastEventAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    timeSpentMs: stats?.timeSpentMs ?? 0,
    pagesSeen: stats?.pagesSeen ?? 0,
    pageCount: stats?.pageCount ?? null,
    downloads: stats?.downloads ?? 0,
    visitNumber: stats?.visitNumber ?? 1,
    docs: (stats?.docs ?? []).map((d) => ({
      docId: String(d.docId),
      title: d.title ?? null,
      timeSpentMs: d.timeSpentMs ?? 0,
      pagesSeen: Array.isArray(d.pagesSeen) ? [...d.pagesSeen] : [],
      pageCount: d.pageCount ?? null,
      downloads: d.downloads ?? 0,
    })),
    brief:
      status === "briefed" && row.brief
        ? {
            headline: row.brief.headline,
            body: row.brief.body,
            interests: [...(row.brief.interests ?? [])],
            highlights: [...(row.brief.highlights ?? [])],
            followUp: row.brief.followUp ?? null,
          }
        : null,
    canWrite: status !== "briefed",
  };
}

export type ListVisitBriefsParams = {
  orgId: Types.ObjectId;
  /** Document-link sittings of this document, or ... */
  docId?: Types.ObjectId | null;
  /** ... project-link sittings of this room. Exactly one of the two. */
  projectId?: Types.ObjectId | null;
  /** One link only. */
  shareId?: string | null;
  /** One reader: the bare device digest, or the account. */
  botIdHash?: string | null;
  viewerUserId?: Types.ObjectId | null;
  limit?: number;
};

/** Finished sittings, newest first, for the reader page (one person) or the MCP (the document). */
export async function listVisitBriefs(params: ListVisitBriefsParams): Promise<VisitBriefCard[]> {
  await connectMongo();
  const query: Record<string, unknown> = {
    orgId: params.orgId,
    status: { $in: [...VISIT_BRIEF_CARD_STATUSES] },
    ...(params.docId ? { docId: params.docId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.shareId ? { shareId: params.shareId } : {}),
    ...(params.viewerUserId ? { viewerUserId: params.viewerUserId } : params.botIdHash ? { botIdHash: params.botIdHash } : {}),
  };
  if (!params.docId && !params.projectId) throw new Error("listVisitBriefs: docId or projectId is required");
  const rows = (await VisitBriefModel.find(query)
    .sort({ startedAt: -1 })
    .limit(Math.min(200, Math.max(1, Math.floor(params.limit ?? 50))))
    .lean()) as Array<VisitBrief & { _id: Types.ObjectId }>;
  return rows.map(visitBriefCard);
}

/**
 * The subject line the model was asked for, built here when it answered with a category instead.
 *
 * gpt-4o at temperature 0 keeps writing "focused on pricing and traction" whatever the prompt
 * says, and a subject that reads like a section heading is the one the sender will not open. When
 * the headline opens with one of the banned verbs, the same template the prompt describes is
 * filled from the facts: the longest-held page's time, the topic from the first `interests` item
 * (which names the page's substance), whether they came back to it, and the download.
 */
export function strongerHeadline(params: {
  headline: string;
  interests: readonly string[];
  stats: Pick<SittingStats, "docs" | "downloads">;
  documentShort: string | null;
}): string {
  const weak = /^(focused|focusing|engaged|engaging|looked|looking|reviewed|reviewing|explored|exploring|viewed|viewing)\b/i;
  if (!weak.test(params.headline.trim())) return params.headline;
  // The longest-held page across the sitting.
  let top: { page: number; ms: number; opened: number } | null = null;
  for (const d of params.stats.docs) {
    const opened = new Map(mapEntries(d.pageVisitCountByPage as unknown as Map<string, number>));
    for (const [page, ms] of mapEntries(d.pageTimeMsByPage as unknown as Map<string, number>)) {
      if (!top || ms > top.ms) top = { page, ms, opened: Math.max(1, opened.get(page) ?? 1) };
    }
  }
  if (!top) return params.headline;
  // The topic: the first interest's clause before its "(p. N)", an em dash, a spaced hyphen, or
  // the " · " that `oneLine` in visitBrief.ts joins object-shaped output with; the prompt makes the
  // clause the substance of the page. Falls back to "page N" rather than to a heading.
  const first = params.interests[0] ?? "";
  const topicRaw = first.split(/\s+\(p\.|\s+—|\s+-\s+|\s+·\s*/)[0]?.trim() ?? "";
  const topic = topicRaw && topicRaw.length <= 90 ? topicRaw.charAt(0).toLowerCase() + topicRaw.slice(1) : `page ${top.page}`;
  const parts = [`spent ${shortDuration(top.ms)} on ${topic}`];
  if (top.opened > 1) parts.push(`came back to it ${top.opened === 2 ? "twice" : `${top.opened} times`}`);
  if (params.stats.downloads > 0) parts.push(`then downloaded ${params.documentShort ? `the ${params.documentShort}` : "it"}`);
  return parts.join(", ");
}

/** "pitch deck" / "whitepaper" / "memo" from a title, when a word in it says what the thing is. */
export function documentShortName(title: string | null): string | null {
  const t = (title ?? "").toLowerCase();
  for (const kind of ["pitch deck", "data room", "whitepaper", "white paper", "financial model", "board deck", "memo", "proposal", "deck", "report", "plan", "overview", "update"]) {
    if (t.includes(kind)) return kind === "white paper" ? "whitepaper" : kind;
  }
  return null;
}

/** Human duration for the feed row: "6 min", "40 s". */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** The feed row and the mail owed, for every visit that ended with something to say. */
async function announceAndEnqueue(params: {
  row: ClaimedRow;
  stats: SittingStats;
  link: LinkInfo | null;
  title: string | null;
  docId: string | null;
  projectId: string | null;
  headline: string | null;
  reason: VisitBriefRecapReason | null;
  now: Date;
  /** False for a manual write: the visit's email already went. */
  email?: boolean;
}): Promise<void> {
  const { row } = params;
  let projectName: string | null = null;
  if (params.projectId) {
    const p = (await ProjectModel.findById(params.projectId).select({ name: 1 }).lean()) as { name?: string } | null;
    projectName = typeof p?.name === "string" ? p.name : null;
  }
  try {
    await recordActivity({
      orgId: row.orgId,
      userId: row.viewerUserId ? String(row.viewerUserId) : null,
      actorKind: "viewer",
      agent: null,
      type: "share.visit_briefed",
      docId: params.docId,
      projectId: params.projectId,
      title: params.title ?? projectName,
      meta: {
        viewerKey: row.botIdHash,
        viewerName: row.viewerName ?? null,
        viewerEmail: row.viewerEmail ?? null,
        shareId: row.shareId,
        linkLabel: params.link?.label ?? null,
        isDefaultLink: params.link?.isDefault ?? true,
        visitBriefId: String(row._id),
        headline: params.headline,
        recapReason: params.reason,
        ...(params.email === false ? { source: "manual" } : null),
        duration: shortDuration(params.stats.timeSpentMs),
        visitNumber: params.stats.visitNumber,
        ...(params.projectId ? { projectId: params.projectId, projectName } : null),
      },
    });
  } catch {
    // best-effort, like every feed row
  }

  if (params.email === false) return;
  const members = (await OrgMembershipModel.find({ orgId: row.orgId, isDeleted: { $ne: true } }).select({ userId: 1 }).lean()) as Array<{ userId?: unknown }>;
  const event = {
    docId: params.docId,
    projectId: params.projectId,
    shareId: row.shareId,
    viewerKey: row.botIdHash,
    viewerName: row.viewerName ?? null,
    viewerEmail: row.viewerEmail ?? null,
    visitBriefId: String(row._id),
  };
  await enqueueNotifications(
    members
      .map((m) => (m?.userId ? String(m.userId) : ""))
      .filter((id) => Types.ObjectId.isValid(id))
      .map((memberUserId) => ({
        orgId: String(row.orgId),
        userId: memberUserId,
        kind: "visit_briefs" as const,
        dedupeKey: notificationDedupeKey("visit_briefs", memberUserId, String(row._id)),
        event,
        occurredAt: params.now,
      })),
  );
  // The brief is the Slack post too. Written now, posted by the tick right after the emails.
  await enqueueSlackPosts({ orgId: String(row.orgId), kind: "briefs", sourceId: String(row._id), event, occurredAt: params.now, postNow: false });
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

export type RunVisitBriefsParams = {
  now?: Date;
  dryRun?: boolean;
  /** Rows claimed this tick. */
  limit?: number;
  workspaceId?: string | null;
  /** Stop claiming once this much of the tick has gone; what is left waits for the next one. */
  timeBudgetMs?: number;
  /** Also drain the `visit_briefs` queue rows this tick wrote (default true), so the mail leaves now. */
  sendEmails?: boolean;
};

export type RunVisitBriefsResult = {
  ok: true;
  now: string;
  dryRun: boolean;
  recovered: number;
  claimed: number;
  postponed: number;
  skipped: number;
  recap: number;
  briefed: number;
  retried: number;
  failed: number;
  creditsCharged: number;
  /** Groups whose settle threw; the row goes back to `scheduled` and is looked at next tick. */
  errors: number;
  emails: SendNotificationEmailsResult | null;
};

/**
 *
 */
export async function runVisitBriefs(params: RunVisitBriefsParams = {}): Promise<RunVisitBriefsResult> {
  const now = params.now ?? new Date();
  const dryRun = Boolean(params.dryRun);
  const startedAt = Date.now();
  const budget = params.timeBudgetMs ?? 240_000;
  const workspaceId = params.workspaceId?.trim() || null;
  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");

  await connectMongo();
  const totals: RunVisitBriefsResult = {
    ok: true,
    now: now.toISOString(),
    dryRun,
    recovered: 0,
    claimed: 0,
    postponed: 0,
    skipped: 0,
    recap: 0,
    briefed: 0,
    retried: 0,
    failed: 0,
    creditsCharged: 0,
    errors: 0,
    emails: null,
  };
  if (!dryRun) totals.recovered = await recoverStaleVisitBriefClaims({ now });

  const rows = (await claimDueVisitBriefs({
    now,
    limit: Math.max(1, Math.floor(params.limit ?? DEFAULT_CLAIM_LIMIT)),
    dryRun,
    orgId: workspaceId ? new Types.ObjectId(workspaceId) : null,
  })) as ClaimedRow[];
  totals.claimed = rows.length;

  let next = 0;
  const workers = Array.from({ length: Math.min(SETTLE_CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const row = rows[next];
      next += 1;
      if (!row) return;
      if (Date.now() - startedAt > budget) {
        // Out of time: hand the row back untouched so the next tick takes it.
        if (!dryRun) await finish(row, { status: "scheduled" });
        totals.postponed += 1;
        continue;
      }
      try {
        const r = await settleVisitBrief(row, { now: new Date(), dryRun });
        totals.creditsCharged += r.creditsCharged;
        if (r.outcome === "postponed") totals.postponed += 1;
        else if (r.outcome === "skipped") totals.skipped += 1;
        else if (r.outcome === "recap") totals.recap += 1;
        else if (r.outcome === "briefed") totals.briefed += 1;
        else if (r.outcome === "retry") totals.retried += 1;
        else if (r.outcome === "failed") totals.failed += 1;
      } catch (err) {
        totals.errors += 1;
        debugError(1, "[visit-briefs] settle failed", { id: String(row._id), message: err instanceof Error ? err.message : String(err) });
        if (!dryRun) {
          try {
            await finish(row, { status: "scheduled", dueAt: new Date(Date.now() + RETRY_BACKOFF_MS[0]!), lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
          } catch {
            // the stale sweep will recover it
          }
        }
      }
    }
  });
  await Promise.all(workers);

  if (params.sendEmails !== false && !dryRun && totals.briefed + totals.recap + totals.failed > 0) {
    try {
      totals.emails = await sendNotificationEmails({ kinds: ["visit_briefs"], workspaceId, now: new Date() });
      await drainSlackOutbox({ workspaceId, now: new Date() });
    } catch (err) {
      // The rows are in the queue; the notification-emails tick sends them within five minutes.
      debugError(1, "[visit-briefs] sending failed; the notification-emails cron will retry", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  return totals;
}
