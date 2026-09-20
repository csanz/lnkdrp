/**
 * Notification email sender — the notification queue's reader
 * (docs/prds/lnkdrp-notification-queue.md, M3).
 *
 * The job is now delivery, not discovery. Writers record "this person is owed this email" at the
 * moment the thing happens (`enqueueNotification`), and a tick here recovers stale claims, claims a
 * bounded batch, resolves each recipient's current preference, renders, sends and marks. Nothing in
 * this file scans `ShareView` / `DocChange` / `Upload` for anything newer than a high-water mark,
 * and nothing reads or writes `NotificationEmailCursor`: a member with no cursor used to be
 * permanently un-emailable, and a failed send used to rewind a cursor instead of retrying one
 * message.
 *
 * Three properties are load-bearing and easy to break:
 *
 * - **A dry run writes nothing at all**, claims included. It reports what the next real tick would
 *   take (`claimBatch({dryRun: true})` reads with the claim's own filter and order) and leaves no
 *   row `sending`. That is what makes the CLI safe to point at production.
 * - **The preference is resolved before anything is claimed.** A `daily` member's rows have to stay
 *   `pending` until the end-of-day tick (decision 6); claiming first and asking later would park
 *   them in `sending` for the rest of the day, where only the stale sweep would find them.
 * - **The bodies and subjects are unchanged.** The view emails come from the same composers
 *   (`viewNotifications.ts`), and the doc-update and request bodies are the same lines this file
 *   built before. What a queue row cannot carry — how far a reader got, the current title, the
 *   diff summary — is loaded from the source row at send time.
 *
 * Called from the Vercel cron route (`/api/cron/notification-emails`) and the local CLI
 * (`scripts/notifications-send-emails.ts`, dry unless `--send`).
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { DocChangeModel } from "@/lib/models/DocChange";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ProjectModel } from "@/lib/models/Project";
import { UserModel } from "@/lib/models/User";
import {
  NotificationQueueModel,
  NOTIFICATION_QUEUE_KINDS,
  type NotificationQueueKind,
} from "@/lib/models/NotificationQueue";
import {
  MAX_ATTEMPTS,
  MAX_CLAIM_BATCH,
  claimBatch,
  claimTokenOf,
  markFailed,
  markSent,
  markSkipped,
  releaseClaims,
  recoverStaleClaims,
  skipPending,
  type ClaimedNotification,
} from "@/lib/notifications/queue";
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { debugError } from "@/lib/debug";
import { resolveConfiguredSiteUrl } from "@/lib/urls";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { viewEmailsOffUrl } from "@/lib/notifications/viewEmailToken";
import {
  DIGEST_MAX_DOCUMENTS,
  composeDigestEmail,
  composeImmediateEmail,
  digestPeriodPhrase,
  groupByDocument,
  loadNewViewerEventsByIds,
  loadViewDocs,
  loadViewLinks,
  loadViewerUserNames,
  normalizeViewEmailMode,
  type ComposeContext,
  type NewViewerEvent,
  type ViewLinkInfo,
  type WorkspacePlan,
} from "@/lib/notifications/viewNotifications";

type Mode = "off" | "daily" | "immediate";

/** Sending modes; `off` never reaches a send, it skips rows. */
type SendMode = Exclude<Mode, "off">;

// Requests (inbound document repositories) are hidden at launch; repo-link-request emails are not
// sent unless NEXT_PUBLIC_FEATURE_REQUESTS=1. Their rows stay `pending` rather than being skipped,
// so whatever was enqueued while the feature was hidden goes out when it ships — but they are left
// out of the tick's work entirely rather than gathered and then declined, or they would sit at the
// head of every tick's oldest-first budget forever. Doc-update emails are unaffected.
const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

/** Default and ceiling for `limitMembers`, counted in (member, kind) groups — one group, one email. */
const DEFAULT_LIMIT_MEMBERS = 5_000;
const MAX_LIMIT_MEMBERS = 50_000;

/** Default and ceiling for `limitEventsPerMember`. */
const DEFAULT_LIMIT_EVENTS_PER_MEMBER = 20;
const MAX_LIMIT_EVENTS_PER_MEMBER = 200;

/**
 * A digest is one message however many rows it covers, so the per-member cap — which exists to stop
 * an `immediate` member getting twenty emails in one tick — does not apply to it.
 *
 * Two things bound a digest and neither loses a row. The claim batch here: rows past it are never
 * claimed. And `DIGEST_MAX_DOCUMENTS` in the body: a view digest renders 50 documents, and rows for
 * documents past that are **released back to `pending`** rather than marked sent (see
 * `buildViewRound`), because a row marked sent for a document that was not in the email is a lie
 * both to the recipient and to `wasNotified()`. Either way the remainder rolls into the next tick,
 * which is what the cursor model could not do — see `digestAllowedNow` for how the once-a-day rule
 * makes room for it.
 */
const DIGEST_CLAIM_LIMIT = MAX_CLAIM_BATCH;

export type SendNotificationEmailsParams = {
  /** When true, compute what would be sent and write nothing — no claims, no marks, no email. */
  dryRun?: boolean;
  /** Optional: restrict to a single workspace/org. */
  workspaceId?: string | null;
  /** Optional: restrict to a single user (the recipient, `queue.userId`). */
  userId?: string | null;
  /**
   * Max (member, kind) groups processed per run (safety bound; default 5,000). Groups are served
   * oldest backlog first, so the bound delays mail rather than losing it; hitting it is reported as
   * `membersTruncated`.
   */
  limitMembers?: number;
  /** Max queue rows an `immediate` member is sent per kind per run; the rest wait for the next tick. */
  limitEventsPerMember?: number;
  /** Force digest sends even if it is not the end-of-day UTC tick. */
  forceDigest?: boolean;
  /** Override "now" for deterministic testing. */
  now?: Date;
};

/** One (kind, mode) bucket of a run, as the admin Emails page renders it. */
export type NotificationBucketTotals = {
  /** Distinct recipients emailed in this bucket. */
  members: number;
  /** Messages sent. */
  emails: number;
  /** Queue rows those messages covered. */
  events: number;
  /** Messages whose send threw. */
  failed: number;
};

export type NotificationDigestTotals = NotificationBucketTotals & {
  /** Whether the digest gate was open this tick — not whether a digest went out. */
  sentTodayUtc: boolean;
};

export type SendNotificationEmailsResult = {
  ok: true;
  now: string;
  dryRun: boolean;
  /** Distinct workspaces with something due this tick. */
  workspacesProcessed: number;
  /** Distinct members with something due this tick. */
  membersProcessed: number;
  /** True when the run stopped at `limitMembers`; the rest are still pending, not lost. */
  membersTruncated: boolean;
  /** Total messages that threw. Each leaves its rows on the backoff schedule, never dropped. */
  sendFailures: number;
  docUpdate: { immediate: NotificationBucketTotals; daily: NotificationDigestTotals };
  repoLinkRequests: { immediate: NotificationBucketTotals; daily: NotificationDigestTotals };
  views: {
    immediate: NotificationBucketTotals;
    /**
     * `returns` counts returning readers folded into a digest. It stays 0 until returns are
     * enqueued: the queue's `share_views` rows are written when a `ShareView` is created, and a
     * return is a `ShareVisit` (PRD table under decision 1). Kept so the shape does not change
     * under the admin page when they are.
     */
    daily: NotificationDigestTotals & { returns: number };
    /** Members whose pending view rows were skipped because their preference is now `off`. */
    off: { members: number };
    /** Groups whose render or load threw; their rows are left for the next tick. */
    errors: number;
  };
  /** The queue's own arithmetic for this tick. */
  queue: {
    /** Rows handed back by the stale-claim sweep (a previous run died mid-send). */
    recovered: number;
    claimed: number;
    sent: number;
    /** Rows that will never be sent: the member is off, or the thing they are about is gone. */
    skipped: number;
    /** Rows put back on the backoff schedule after a failed send. */
    retried: number;
    /** Rows that used up `MAX_ATTEMPTS` this tick and are now dead letters. */
    dead: number;
    /** Rows left pending on purpose: a digest before its tick, or a flag-gated kind. */
    deferred: number;
  };
};

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/** Where email links point when no site URL is configured outside production (`next dev -p 3001`). */
export const LOCAL_DEV_EMAIL_BASE_URL = "http://localhost:3001";

/**
 * Absolute base for every link in a notification email, without a trailing slash.
 *
 * `NEXT_PUBLIC_SITE_URL`, then `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL` and `VERCEL_URL` (the same order
 * as `resolveConfiguredSiteUrl`); outside production, the local dev server. Empty only in production
 * with none of them set: a relative link does nothing in a mail client, so view emails are held back
 * in that case (see `runGroup`) and the other kinds keep their old relative links.
 */
export function publicBaseUrl(): string {
  const configured = resolveConfiguredSiteUrl();
  if (configured) return configured.toString().replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? "" : LOCAL_DEV_EMAIL_BASE_URL;
}

function buildDocUrl(docId: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/doc/${encodeURIComponent(docId)}` : `/doc/${encodeURIComponent(docId)}`;
}

function buildDocHistoryUrl(docId: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/doc/${encodeURIComponent(docId)}/history` : `/doc/${encodeURIComponent(docId)}/history`;
}

function buildRequestsUrl(): string {
  const base = publicBaseUrl();
  return base ? `${base}/requests` : "/requests";
}

function shouldSendDailyUtc(now: Date, force: boolean): boolean {
  if (force) return true;
  // "End of day" is currently interpreted as end-of-day UTC.
  // (We can later honor per-workspace/per-user timezones when persisted.)
  return now.getUTCHours() >= 23;
}

/** Midnight UTC of the day `now` falls in — the day a "daily" member gets one email in. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Has this member already had their one digest today, and if so is there anything left over?
 *
 * The hour gate opens at 23:00 UTC and the cron runs every five minutes, so on its own it is a
 * licence to send twelve digests between 23:00 and midnight — one at 23:05, then another at 23:10
 * for the single row a reader created at 23:07, and so on. The cursor model got this one thing
 * right (`lastDigestDay`); the queue has to answer it from the queue.
 *
 * "Already sent today" is a `sent` row for this (member, kind) stamped since midnight UTC. A daily
 * member's rows are only ever marked sent by a digest, so that row *is* the digest.
 *
 * The exception is the one the old runner also made (`digestTruncated`): a digest that could not
 * carry everything must be allowed to send the rest the same day, or a workspace with more than
 * `DIGEST_MAX_DOCUMENTS` documents a day never catches up. Left-over rows are recognisable without
 * any extra bookkeeping — they are `pending` rows whose event happened *before* the digest went
 * out. Anything that happened after it is tomorrow's news.
 *
 * One edge this accepts rather than papers over: a member who was on `immediate` earlier today and
 * switches to `daily` has a `sent` row from this morning, so their first digest is tomorrow's.
 * That is what they asked for — one email a day — and the rows are still pending, not lost.
 */
async function digestAllowedNow(params: {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  kind: NotificationQueueKind;
  now: Date;
}): Promise<boolean> {
  const { orgId, userId, kind, now } = params;
  const scope = { orgId, userId, kind };

  const lastDigest = (await NotificationQueueModel.findOne({
    ...scope,
    status: "sent",
    sentAt: { $gte: startOfUtcDay(now) },
  })
    .sort({ sentAt: -1 })
    .select({ sentAt: 1 })
    .lean()) as { sentAt?: Date | null } | null;

  const sentAt = lastDigest?.sentAt instanceof Date ? lastDigest.sentAt : null;
  if (!sentAt) return true;

  const leftOver = await NotificationQueueModel.findOne({
    ...scope,
    status: "pending",
    nextAttemptAt: { $lte: now },
    occurredAt: { $lt: sentAt },
  })
    .select({ _id: 1 })
    .lean();
  return Boolean(leftOver);
}

/**
 * The source row a queue entry is about: the last segment of its `dedupeKey`
 * (`<kind>:<userId>:<source row id>` — see `notificationDedupeKey`).
 *
 * The event snapshot says what the email should read like, not which row it came from, so this is
 * the only handle back to the `ShareView`, the replacement `Upload` or the request upload — and it
 * is the one the unique index already guarantees is there.
 */
function sourceIdOf(row: ClaimedNotification): string | null {
  const parts = row.dedupeKey.split(":");
  const id = parts.length >= 3 ? parts[parts.length - 1]!.trim() : "";
  return Types.ObjectId.isValid(id) ? id : null;
}

/** `ClaimedNotification.event` hands back strings, but the shared event type still allows ids. */
function toObjectIdOrNull(v: string | Types.ObjectId | null | undefined): Types.ObjectId | null {
  if (v instanceof Types.ObjectId) return v;
  const s = String(v ?? "").trim();
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

// ---------------------------------------------------------------------------------------------
// What is owed, and to whom
// ---------------------------------------------------------------------------------------------

type DueGroup = {
  orgId: string;
  userId: string;
  kind: NotificationQueueKind;
  /** Pending rows due now in this group; the claim may take fewer. */
  due: number;
  /** `occurredAt` of the oldest of them — the run serves the furthest-behind group first. */
  oldestOccurredAt: Date | null;
};

/**
 * Who is owed what, right now: due `pending` rows grouped by (workspace, member, kind).
 *
 * This lives here rather than in `queue.ts` because it is the reader's question, not the queue's:
 * the queue hands out claims and marks, and only the sender needs to know that one preference has
 * to be resolved per member per kind *before* anything is claimed. The `{status, nextAttemptAt}`
 * index covers the match.
 */
async function loadDueGroups(params: {
  orgId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
  /** Kinds a tick can actually deliver; a flag-gated one is excluded here rather than per group. */
  kinds: readonly NotificationQueueKind[];
  now: Date;
  limit: number;
}): Promise<DueGroup[]> {
  const match: Record<string, unknown> = { status: "pending", nextAttemptAt: { $lte: params.now } };
  if (params.orgId) match.orgId = params.orgId;
  if (params.userId) match.userId = params.userId;
  // Groups are served oldest backlog first and truncated at `limitMembers`, so a kind that cannot
  // be delivered at all must not be gathered: its rows never age out of the head of the queue, and
  // with Requests hidden they would sort in front of every deliverable group, every tick, forever.
  if (params.kinds.length < NOTIFICATION_QUEUE_KINDS.length) match.kind = { $in: params.kinds };

  const rows = (await NotificationQueueModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: { orgId: "$orgId", userId: "$userId", kind: "$kind" },
        due: { $sum: 1 },
        oldestOccurredAt: { $min: "$occurredAt" },
      },
    },
    { $sort: { oldestOccurredAt: 1 } },
    { $limit: params.limit },
  ])) as Array<{ _id: { orgId: unknown; userId: unknown; kind: NotificationQueueKind }; due: number; oldestOccurredAt: Date | null }>;

  const groups: DueGroup[] = [];
  for (const row of rows) {
    const orgId = row?._id?.orgId ? String(row._id.orgId) : "";
    const userId = row?._id?.userId ? String(row._id.userId) : "";
    if (!Types.ObjectId.isValid(orgId) || !Types.ObjectId.isValid(userId) || !row?._id?.kind) continue;
    groups.push({
      orgId,
      userId,
      kind: row._id.kind,
      due: Number(row.due) || 0,
      oldestOccurredAt: row.oldestOccurredAt instanceof Date ? row.oldestOccurredAt : null,
    });
  }
  return groups;
}

/**
 * How many due rows a tick is deliberately not looking at.
 *
 * One count, not an aggregate: this exists so a flag-gated backlog still shows up as `deferred` in
 * the run's arithmetic after being left out of `loadDueGroups`. "Nothing was gathered" and "nothing
 * was owed" are different answers and the admin page renders them differently.
 */
async function countDueRows(params: {
  orgId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
  kinds: readonly NotificationQueueKind[];
  now: Date;
}): Promise<number> {
  if (!params.kinds.length) return 0;
  const match: Record<string, unknown> = {
    status: "pending",
    nextAttemptAt: { $lte: params.now },
    kind: { $in: params.kinds },
  };
  if (params.orgId) match.orgId = params.orgId;
  if (params.userId) match.userId = params.userId;
  const n = await NotificationQueueModel.countDocuments(match);
  return Number.isFinite(n) ? n : 0;
}

/** Everything about a recipient that is read at send time rather than at enqueue (decision 2). */
type Recipient = {
  /** The off link in a view email is signed with the membership, not the user. */
  membershipId: string;
  email: string | null;
  modes: Record<NotificationQueueKind, Mode>;
};

function recipientKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

/**
 * Current preference and address for every member with something due.
 *
 * Two queries for the whole run: memberships by (orgs × users) rather than one `$or` clause per
 * pair, because a workspace has few memberships and Mongo can use the index for both sides.
 */
async function loadRecipients(groups: readonly DueGroup[]): Promise<Map<string, Recipient>> {
  const out = new Map<string, Recipient>();
  if (!groups.length) return out;

  const orgIds = Array.from(new Set(groups.map((g) => g.orgId))).map((id) => new Types.ObjectId(id));
  const userIds = Array.from(new Set(groups.map((g) => g.userId))).map((id) => new Types.ObjectId(id));

  const memberships = await OrgMembershipModel.find({
    isDeleted: { $ne: true },
    orgId: { $in: orgIds },
    userId: { $in: userIds },
  })
    .select({ _id: 1, orgId: 1, userId: 1, docUpdateEmailMode: 1, repoLinkRequestEmailMode: 1, viewEmailMode: 1 })
    .lean();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of memberships as any[]) {
    const orgId = m?.orgId ? String(m.orgId) : "";
    const userId = m?.userId ? String(m.userId) : "";
    if (!Types.ObjectId.isValid(orgId) || !Types.ObjectId.isValid(userId)) continue;
    out.set(recipientKey(orgId, userId), {
      membershipId: m?._id ? String(m._id) : "",
      email: null,
      modes: {
        // A stored row with no value means "daily" for all three, as the preferences UI does.
        doc_updates: (m?.docUpdateEmailMode ?? "daily") as Mode,
        repo_link_requests: (m?.repoLinkRequestEmailMode ?? "daily") as Mode,
        share_views: normalizeViewEmailMode(m?.viewEmailMode),
      },
    });
  }

  const users = await UserModel.find({ _id: { $in: userIds }, isActive: { $ne: false } })
    .select({ _id: 1, email: 1 })
    .lean();
  const emailByUser = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const u of users as any[]) {
    const id = u?._id ? String(u._id) : "";
    const email = typeof u?.email === "string" ? u.email.trim() : "";
    if (Types.ObjectId.isValid(id) && email) emailByUser.set(id, email);
  }
  for (const g of groups) {
    const r = out.get(recipientKey(g.orgId, g.userId));
    if (r) r.email = emailByUser.get(g.userId) ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering: one round of work for one member and one kind
// ---------------------------------------------------------------------------------------------

/** One outgoing message and the queue rows it covers — a digest covers many, an immediate few. */
type Delivery = {
  subject: string;
  text: string;
  html?: string;
  /** Extra mail headers, e.g. RFC 8058 one-click unsubscribe on view emails. */
  headers?: Record<string, string>;
  rows: ClaimedNotification[];
};

/** What one claimed batch turned into: messages to send, and rows that will never be sent. */
type Round = {
  deliveries: Delivery[];
  skipped: Array<{ id: string; reason: string }>;
  /**
   * Rows this round claimed but did not put in any email: the message could not carry them. They
   * go back to `pending` unsent and unpenalised, never `sent` — see `releaseClaims`.
   */
  deferred?: ClaimedNotification[];
};

const SKIP_DOCUMENT_GONE = "document deleted or archived";
const SKIP_SOURCE_GONE = "source row no longer exists";

/**
 * View emails, from the same composers the cursor runner used.
 *
 * The queue row names a `ShareView`; the email says how far that reader got, which only the row
 * knows, so each claimed row is rehydrated before anything is composed. A row whose view or
 * document is gone is skipped rather than retried — neither will come back.
 */
async function buildViewRound(params: {
  orgId: Types.ObjectId;
  rows: ClaimedNotification[];
  mode: SendMode;
  membershipId: string;
  appUrl: string;
  now: Date;
  plan: WorkspacePlan;
}): Promise<Round> {
  const skipped: Round["skipped"] = [];
  const sourceIds = params.rows.map((row) => sourceIdOf(row)).filter((id): id is string => Boolean(id));
  const eventById = await loadNewViewerEventsByIds(params.orgId, sourceIds);

  const usable: Array<{ row: ClaimedNotification; event: NewViewerEvent }> = [];
  for (const row of params.rows) {
    const sourceId = sourceIdOf(row);
    const event = sourceId ? eventById.get(sourceId) : undefined;
    if (!event) {
      skipped.push({ id: row.id, reason: SKIP_SOURCE_GONE });
      continue;
    }
    usable.push({ row, event });
  }
  if (!usable.length) return { deliveries: [], skipped };

  const docs = await loadViewDocs(
    params.orgId,
    usable.map((u) => u.event.docId),
  );
  const live = usable.filter((u) => docs.has(u.event.docId));
  for (const u of usable) if (!docs.has(u.event.docId)) skipped.push({ id: u.row.id, reason: SKIP_DOCUMENT_GONE });
  if (!live.length) return { deliveries: [], skipped };

  const events = live.map((u) => u.event);
  const links: ReadonlyMap<string, ViewLinkInfo> = await loadViewLinks(events);
  if (params.plan === "pro") {
    const names = await loadViewerUserNames(events.map((e) => e.viewerUserId).filter((id): id is string => Boolean(id)));
    for (const e of events) if (e.viewerUserId) e.viewerUserName = names.get(e.viewerUserId) ?? null;
  }

  const ctx: ComposeContext = {
    appUrl: params.appUrl,
    offUrl: viewEmailsOffUrl(params.appUrl, params.membershipId, { now: params.now }),
    plan: params.plan,
  };
  const rowByEvent = new Map(live.map((u) => [u.event.id, u.row]));
  const rowsFor = (group: readonly NewViewerEvent[]): ClaimedNotification[] =>
    group.map((e) => rowByEvent.get(e.id)).filter((r): r is ClaimedNotification => Boolean(r));

  if (params.mode === "immediate") {
    // One email per document, as the view PRD's decision 7 has always had it. Unlike the cursor
    // runner, a failed document no longer stops the round: each document's rows carry their own
    // retry, so a later document is not held hostage by an earlier failure.
    //
    const deliveries: Delivery[] = [];
    for (const group of groupByDocument(events)) {
      const doc = docs.get(group.docId);
      if (!doc) continue;
      const email = composeImmediateEmail({ ctx, doc, events: group.events, links });
      deliveries.push({ ...email, rows: rowsFor(group.events) });
    }
    return { deliveries, skipped };
  }

  // The body renders at most `DIGEST_MAX_DOCUMENTS` documents and replaces the rest with a
  // headcount, so the claim is trimmed to what the email will actually say. Marking the overflow
  // `sent` would tell `wasNotified()` that this member was told about documents whose detail never
  // left the building — the same silent loss the queue exists to remove. They are handed back
  // instead and lead the next digest, which `digestAllowedNow` lets through the same day.
  const rendered = groupByDocument(events).slice(0, DIGEST_MAX_DOCUMENTS);
  const renderedDocIds = new Set(rendered.map((g) => g.docId));
  const inDigest = live.filter((u) => renderedDocIds.has(u.event.docId));
  const deferred = live.filter((u) => !renderedDocIds.has(u.event.docId)).map((u) => u.row);

  const oldest = inDigest.reduce<Date>(
    (min, u) => (u.row.occurredAt < min ? u.row.occurredAt : min),
    inDigest[0]!.row.occurredAt,
  );
  const email = composeDigestEmail({
    ctx,
    docs,
    views: inDigest.map((u) => u.event),
    // Returns are `ShareVisit` rows and nothing enqueues them yet (decision 1's table); when they
    // are queued they arrive as their own rows and this is where they join the digest.
    returns: [],
    links,
    period: digestPeriodPhrase(oldest, params.now),
  });
  return { deliveries: [{ ...email, rows: inDigest.map((u) => u.row) }], skipped, deferred };
}

/** One doc update, resolved from its replacement upload back to the change it recorded. */
type DocUpdateItem = { row: ClaimedNotification; docId: string; title: string; version: number | null; summary: string };

/**
 * Doc-update emails: the same lines this file has always sent, fed from the queue.
 *
 * **The document comes from the queue row, not from `DocChange`.** The row's own `event` carries
 * `docId` and `version`, which is everything the body needs except the diff summary; `DocChange` is
 * consulted only for that one optional line. Resolving the *document* through `DocChange` dropped
 * mail on the floor: the enqueue fires whenever a replacement lands, while the `DocChange` write is
 * gated on both versions having extractable text and sits inside a best-effort try. Replace a
 * scanned contract with another scanned contract and there is no change row, so every member's row
 * was marked "source row no longer exists" — permanently, wrongly (the Upload was right there), and
 * invisibly, since a skipped row is neither pending nor dead on the admin page.
 *
 * `Upload` is the fallback for a row whose event predates that field. The current title is read now
 * rather than trusted from the event snapshot, because a rename between the upload and the send
 * should show the name the recipient will see when they click through.
 */
async function buildDocUpdateRound(params: {
  orgId: Types.ObjectId;
  orgIdStr: string;
  rows: ClaimedNotification[];
  mode: SendMode;
}): Promise<Round> {
  const skipped: Round["skipped"] = [];

  /** upload id -> the row(s) it belongs to, for the rows whose event has no document. */
  const uploadLookups = new Map<string, Types.ObjectId>();
  const uploadIds = new Map<string, Types.ObjectId>();
  for (const row of params.rows) {
    const uploadId = toObjectIdOrNull(row.event.uploadId ?? sourceIdOf(row));
    if (uploadId) uploadIds.set(String(uploadId), uploadId);
    if (!toObjectIdOrNull(row.event.docId) && uploadId) uploadLookups.set(row.id, uploadId);
  }

  const uploadInfo = new Map<string, { docId: string; version: number | null }>();
  if (uploadLookups.size) {
    const uploads = await UploadModel.find({
      _id: { $in: Array.from(new Set(uploadLookups.values())) },
      orgId: params.orgId,
    })
      .select({ _id: 1, docId: 1, version: 1 })
      .lean();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const u of uploads as any[]) {
      const id = u?._id ? String(u._id) : "";
      const docId = u?.docId ? String(u.docId) : "";
      if (!id || !Types.ObjectId.isValid(docId)) continue;
      uploadInfo.set(id, { docId, version: Number.isFinite(Number(u?.version)) ? Number(u.version) : null });
    }
  }

  // The summary only. A missing change row costs the email one line, never the email.
  const changes = uploadIds.size
    ? await DocChangeModel.find({ orgId: params.orgId, toUploadId: { $in: Array.from(uploadIds.values()) } })
        .select({ _id: 1, docId: 1, toUploadId: 1, toVersion: 1, "diff.summary": 1 })
        .lean()
    : [];
  const summaryByUpload = new Map<string, string>();
  const versionByUpload = new Map<string, number>();
  const changeDocByUpload = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of changes as any[]) {
    const uploadId = c?.toUploadId ? String(c.toUploadId) : "";
    if (!uploadId) continue;
    const summary = typeof c?.diff?.summary === "string" ? c.diff.summary.trim() : "";
    if (summary) summaryByUpload.set(uploadId, summary);
    if (Number.isFinite(Number(c?.toVersion))) versionByUpload.set(uploadId, Number(c.toVersion));
    const docId = c?.docId ? String(c.docId) : "";
    if (Types.ObjectId.isValid(docId)) changeDocByUpload.set(uploadId, docId);
  }

  /** What each row is about, resolved event-first. */
  const resolved = new Map<string, { docId: string; version: number | null; summary: string }>();
  for (const row of params.rows) {
    const uploadId = String(toObjectIdOrNull(row.event.uploadId ?? sourceIdOf(row)) ?? "");
    const fromUpload = uploadId ? uploadInfo.get(uploadId) : undefined;
    // Event first, then whatever the change row happened to record, then the upload itself. Only a
    // row that names none of the three has nothing left to be about.
    const docId = String(
      toObjectIdOrNull(row.event.docId) ?? (uploadId ? changeDocByUpload.get(uploadId) : null) ?? fromUpload?.docId ?? "",
    );
    if (!Types.ObjectId.isValid(docId)) {
      skipped.push({ id: row.id, reason: SKIP_SOURCE_GONE });
      continue;
    }
    const version =
      (Number.isFinite(Number(row.event.version)) ? Number(row.event.version) : null) ??
      (uploadId ? versionByUpload.get(uploadId) ?? fromUpload?.version ?? null : null);
    resolved.set(row.id, { docId, version, summary: (uploadId && summaryByUpload.get(uploadId)) || "" });
  }

  const docTitles = await loadDocTitles(params.orgId, Array.from(resolved.values()).map((r) => r.docId));

  const items: DocUpdateItem[] = [];
  for (const row of params.rows) {
    const about = resolved.get(row.id);
    if (!about) continue; // Already skipped above: nothing names a document.
    const title = docTitles.get(about.docId);
    if (!title) {
      skipped.push({ id: row.id, reason: SKIP_DOCUMENT_GONE });
      continue;
    }
    items.push({ row, docId: about.docId, title, version: about.version, summary: about.summary });
  }
  if (!items.length) return { deliveries: [], skipped };
  items.sort((a, b) => a.row.occurredAt.getTime() - b.row.occurredAt.getTime());

  const daily = params.mode === "daily";
  const subject = daily
    ? `Daily digest: ${items.length} doc update${items.length === 1 ? "" : "s"}`
    : items.length === 1
      ? `Doc updated: ${items[0]!.title}`
      : `${items.length} docs updated`;

  const lines: string[] = [];
  lines.push(
    daily
      ? `Doc updates in your workspace (${params.orgIdStr})`
      : `New doc update${items.length === 1 ? "" : "s"} in your workspace (${params.orgIdStr})`,
    "",
  );
  for (const item of items) {
    lines.push(`- ${item.title}${item.version ? ` (v${item.version})` : ""}`);
    if (item.summary) lines.push(`  ${item.summary}`);
    lines.push(`  ${daily ? buildDocHistoryUrl(item.docId) : buildDocUrl(item.docId)}`);
  }
  lines.push("", "- LinkDrop");

  return { deliveries: [{ subject, text: lines.join("\n"), rows: items.map((i) => i.row) }], skipped };
}

/** One request upload, resolved back to the request repo it landed in. */
type RepoLinkItem = { row: ClaimedNotification; docId: string; docTitle: string; requestName: string };

/**
 * Repo-link-request emails: unchanged lines, fed from the queue.
 *
 * The row names the completed upload; the body names the request repo it landed in, which lives on
 * the document (`receivedViaRequestProjectId`). A document that is no longer a request document is
 * skipped rather than emailed as a bare upload.
 */
async function buildRepoLinkRound(params: {
  orgId: Types.ObjectId;
  orgIdStr: string;
  rows: ClaimedNotification[];
  mode: SendMode;
}): Promise<Round> {
  const skipped: Round["skipped"] = [];

  // The event carries the document for rows written by the request route; older or partial rows
  // only name the upload, so those are resolved through it.
  const docIdByRow = new Map<string, string>();
  const uploadLookups = new Map<string, Types.ObjectId>();
  for (const row of params.rows) {
    const docId = toObjectIdOrNull(row.event.docId);
    if (docId) {
      docIdByRow.set(row.id, String(docId));
      continue;
    }
    const uploadId = toObjectIdOrNull(row.event.requestId ?? sourceIdOf(row));
    if (uploadId) uploadLookups.set(row.id, uploadId);
  }
  if (uploadLookups.size) {
    const uploads = await UploadModel.find({
      _id: { $in: Array.from(new Set(uploadLookups.values())) },
      orgId: params.orgId,
      isDeleted: { $ne: true },
    })
      .select({ _id: 1, docId: 1 })
      .lean();
    const docByUpload = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const u of uploads as any[]) {
      const id = u?._id ? String(u._id) : "";
      const docId = u?.docId ? String(u.docId) : "";
      if (id && Types.ObjectId.isValid(docId)) docByUpload.set(id, docId);
    }
    for (const [rowId, uploadId] of uploadLookups) {
      const docId = docByUpload.get(String(uploadId));
      if (docId) docIdByRow.set(rowId, docId);
    }
  }

  const requestDocs = await loadRequestDocs(params.orgId, Array.from(new Set(docIdByRow.values())));

  const items: RepoLinkItem[] = [];
  for (const row of params.rows) {
    const docId = docIdByRow.get(row.id);
    const doc = docId ? requestDocs.get(docId) : undefined;
    if (!doc) {
      skipped.push({ id: row.id, reason: docId ? SKIP_DOCUMENT_GONE : SKIP_SOURCE_GONE });
      continue;
    }
    items.push({ row, docId: docId!, docTitle: doc.title, requestName: doc.requestName });
  }
  if (!items.length) return { deliveries: [], skipped };
  items.sort((a, b) => a.row.occurredAt.getTime() - b.row.occurredAt.getTime());

  const daily = params.mode === "daily";
  const subject = daily
    ? `Daily digest: ${items.length} repo link request${items.length === 1 ? "" : "s"}`
    : items.length === 1
      ? `Repo link request: ${items[0]!.requestName}`
      : `${items.length} repo link requests`;

  const lines: string[] = [];
  lines.push(
    daily
      ? `New request uploads in your workspace (${params.orgIdStr})`
      : `New request upload${items.length === 1 ? "" : "s"} in your workspace (${params.orgIdStr})`,
    "",
  );
  for (const item of items) {
    lines.push(`- ${item.requestName}: ${item.docTitle}`);
    lines.push(`  ${buildDocUrl(item.docId)}`);
  }
  lines.push("", `Requests: ${buildRequestsUrl()}`, "", "- LinkDrop");

  return { deliveries: [{ subject, text: lines.join("\n"), rows: items.map((i) => i.row) }], skipped };
}

/** Titles of the workspace's live documents, by id. An empty title reads as "Document", as before. */
async function loadDocTitles(orgId: Types.ObjectId, docIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(docIds)).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return out;
  const docs = await DocModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    orgId,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1, title: 1 })
    .lean();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of docs as any[]) {
    const id = d?._id ? String(d._id) : "";
    if (!Types.ObjectId.isValid(id)) continue;
    const title = typeof d?.title === "string" ? d.title.trim() : "";
    out.set(id, title || "Document");
  }
  return out;
}

/** Live request documents by id, with the name of the request repo they landed in. */
async function loadRequestDocs(
  orgId: Types.ObjectId,
  docIds: readonly string[],
): Promise<Map<string, { title: string; requestName: string }>> {
  const out = new Map<string, { title: string; requestName: string }>();
  const ids = Array.from(new Set(docIds)).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return out;

  const docs = await DocModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    orgId,
    isDeleted: { $ne: true },
    receivedViaRequestProjectId: { $ne: null },
  })
    .select({ _id: 1, title: 1, receivedViaRequestProjectId: 1 })
    .lean();

  const rows: Array<{ docId: string; title: string; projectId: string }> = [];
  const projectIds = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of docs as any[]) {
    const docId = d?._id ? String(d._id) : "";
    const projectId = d?.receivedViaRequestProjectId ? String(d.receivedViaRequestProjectId) : "";
    if (!Types.ObjectId.isValid(docId) || !Types.ObjectId.isValid(projectId)) continue;
    const title = typeof d?.title === "string" ? d.title.trim() : "";
    rows.push({ docId, title: title || "Document", projectId });
    projectIds.add(projectId);
  }
  if (!rows.length) return out;

  const projects = await ProjectModel.find({
    _id: { $in: Array.from(projectIds).map((id) => new Types.ObjectId(id)) },
    orgId,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1, name: 1 })
    .lean();
  const projectName = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of projects as any[]) {
    const id = p?._id ? String(p._id) : "";
    if (!Types.ObjectId.isValid(id)) continue;
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    projectName.set(id, name || "Request");
  }
  for (const row of rows) out.set(row.docId, { title: row.title, requestName: projectName.get(row.projectId) ?? "Request" });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sending and marking
// ---------------------------------------------------------------------------------------------

type SendOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Send one message, isolating the failure.
 *
 * The error is handed back rather than logged and swallowed, because `markFailed` writes it onto
 * the row as `lastError`: a dead letter with no reason on it is the state the queue exists to
 * replace.
 */
async function trySendEmail(params: {
  dryRun: boolean;
  to: string;
  delivery: Delivery;
  context: { orgId: string; userId: string; kind: NotificationQueueKind; mode: SendMode };
}): Promise<SendOutcome> {
  if (params.dryRun) return { ok: true };
  try {
    await sendTextEmail({
      to: params.to,
      subject: params.delivery.subject,
      text: params.delivery.text,
      ...(params.delivery.html ? { html: params.delivery.html } : {}),
      ...(params.delivery.headers ? { headers: params.delivery.headers } : {}),
    });
    return { ok: true };
  } catch (err) {
    debugError(1, "[notification-emails] send failed", {
      ...params.context,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err };
  }
}

function bucketFor(
  totals: SendNotificationEmailsResult,
  kind: NotificationQueueKind,
  mode: SendMode,
): NotificationBucketTotals {
  const group =
    kind === "share_views" ? totals.views : kind === "doc_updates" ? totals.docUpdate : totals.repoLinkRequests;
  return mode === "immediate" ? group.immediate : group.daily;
}

/**
 * Send a round and write its outcome back to the queue.
 *
 * Marks are per message, not per round: a digest of forty rows is marked in one update, and one
 * failed immediate email leaves only its own rows on the backoff schedule. A dry run counts all of
 * this and writes none of it.
 */
async function deliverRound(params: {
  round: Round;
  to: string;
  kind: NotificationQueueKind;
  mode: SendMode;
  orgId: string;
  userId: string;
  /** The claim these rows belong to; every mark carries it so a re-claim is never overwritten. */
  claimToken: string | null;
  dryRun: boolean;
  now: Date;
  totals: SendNotificationEmailsResult;
}): Promise<void> {
  const { round, totals, dryRun, now } = params;
  const bucket = bucketFor(totals, params.kind, params.mode);
  let emailed = false;

  for (const delivery of round.deliveries) {
    if (!delivery.rows.length) continue;
    const outcome = await trySendEmail({
      dryRun,
      to: params.to,
      delivery,
      context: { orgId: params.orgId, userId: params.userId, kind: params.kind, mode: params.mode },
    });

    if (outcome.ok) {
      emailed = true;
      bucket.emails += 1;
      bucket.events += delivery.rows.length;
      totals.queue.sent += delivery.rows.length;
      if (!dryRun) {
        await markSent({ ids: delivery.rows.map((r) => r.id), claimToken: params.claimToken, now });
      }
      continue;
    }

    bucket.failed += 1;
    totals.sendFailures += 1;
    for (const row of delivery.rows) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) totals.queue.dead += 1;
      else totals.queue.retried += 1;
    }
    if (!dryRun) {
      await markFailed({
        rows: delivery.rows.map((r) => ({ id: r.id, attempts: r.attempts })),
        claimToken: params.claimToken,
        error: outcome.error,
        now,
      });
    }
  }
  if (emailed) bucket.members += 1;

  await recordSkips({ skipped: round.skipped, claimToken: params.claimToken, dryRun, now, totals });

  // Rows the message could not carry go back unsent and unpenalised. Counted as deferred, which is
  // what they are: still owed, and due again on the next tick.
  const deferred = round.deferred ?? [];
  if (deferred.length) {
    totals.queue.deferred += deferred.length;
    if (!dryRun) {
      await releaseClaims({ ids: deferred.map((r) => r.id), claimToken: params.claimToken, now });
    }
  }
}

/** Mark rows that will never be sent, one update per reason. */
async function recordSkips(params: {
  skipped: Round["skipped"];
  /** The claim these ids came from, when they came from one; see `markSkipped`. */
  claimToken?: string | null;
  dryRun: boolean;
  now: Date;
  totals: SendNotificationEmailsResult;
}): Promise<void> {
  if (!params.skipped.length) return;
  params.totals.queue.skipped += params.skipped.length;
  if (params.dryRun) return;
  const byReason = new Map<string, string[]>();
  for (const s of params.skipped) {
    const bucket = byReason.get(s.reason);
    if (bucket) bucket.push(s.id);
    else byReason.set(s.reason, [s.id]);
  }
  for (const [reason, ids] of byReason) {
    await markSkipped({ ids, reason, claimToken: params.claimToken ?? null, now: params.now });
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

function emptyTotals(now: Date, dryRun: boolean, allowDaily: boolean): SendNotificationEmailsResult {
  const bucket = (): NotificationBucketTotals => ({ members: 0, emails: 0, events: 0, failed: 0 });
  const digest = (): NotificationDigestTotals => ({ ...bucket(), sentTodayUtc: allowDaily });
  return {
    ok: true,
    now: now.toISOString(),
    dryRun,
    workspacesProcessed: 0,
    membersProcessed: 0,
    membersTruncated: false,
    sendFailures: 0,
    docUpdate: { immediate: bucket(), daily: digest() },
    repoLinkRequests: { immediate: bucket(), daily: digest() },
    views: { immediate: bucket(), daily: { ...digest(), returns: 0 }, off: { members: 0 }, errors: 0 },
    queue: { recovered: 0, claimed: 0, sent: 0, skipped: 0, retried: 0, dead: 0, deferred: 0 },
  };
}

export async function sendNotificationEmails(
  params: SendNotificationEmailsParams = {},
): Promise<SendNotificationEmailsResult> {
  const now = params.now ?? new Date();
  const dryRun = Boolean(params.dryRun);
  const limitMembers = Math.min(MAX_LIMIT_MEMBERS, asPositiveInt(params.limitMembers) ?? DEFAULT_LIMIT_MEMBERS);
  const limitEventsPerMember = Math.min(
    MAX_LIMIT_EVENTS_PER_MEMBER,
    asPositiveInt(params.limitEventsPerMember) ?? DEFAULT_LIMIT_EVENTS_PER_MEMBER,
  );
  const allowDaily = shouldSendDailyUtc(now, Boolean(params.forceDigest));

  const workspaceId = params.workspaceId?.trim() || null;
  const userId = params.userId?.trim() || null;
  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  if (userId && !Types.ObjectId.isValid(userId)) throw new Error("Invalid userId");

  await connectMongo();
  const totals = emptyTotals(now, dryRun, allowDaily);

  // A run that died mid-send left its rows `sending`; hand them back before asking what is due, so
  // this tick picks them up instead of waiting for the next one. Reads only on a dry run.
  if (!dryRun) totals.queue.recovered = await recoverStaleClaims({ now });

  // Requests are hidden behind a flag at launch. Their rows stay `pending` — whatever was enqueued
  // while the feature was hidden goes out the day it ships (decision 2's reasoning, applied to a
  // feature flag) — but they are not gathered as work: `loadDueGroups` serves the oldest backlog
  // first and truncates at `limitMembers`, so a kind that can never be delivered would sit at the
  // head of every tick's budget forever, crowding out mail that can. They are counted instead.
  const deliverableKinds = NOTIFICATION_QUEUE_KINDS.filter(
    (k) => k !== "repo_link_requests" || FEATURE_REQUESTS_ENABLED,
  );
  const scope = {
    orgId: workspaceId ? new Types.ObjectId(workspaceId) : null,
    userId: userId ? new Types.ObjectId(userId) : null,
  };
  if (deliverableKinds.length < NOTIFICATION_QUEUE_KINDS.length) {
    totals.queue.deferred += await countDueRows({
      ...scope,
      kinds: NOTIFICATION_QUEUE_KINDS.filter((k) => !deliverableKinds.includes(k)),
      now,
    });
  }

  const groups = await loadDueGroups({
    ...scope,
    kinds: deliverableKinds,
    now,
    // One over the bound, so hitting it is distinguishable from landing exactly on it.
    limit: limitMembers + 1,
  });
  if (groups.length > limitMembers) {
    groups.length = limitMembers;
    totals.membersTruncated = true;
    debugError(1, "[notification-emails] more groups due than limitMembers; the rest stay pending", { limitMembers });
  }
  if (!groups.length) return totals;

  const recipients = await loadRecipients(groups);
  const appUrl = publicBaseUrl();
  /** One plan lookup per workspace per tick; identity in a view email depends on it. */
  const plans = new Map<string, WorkspacePlan>();
  const workspaces = new Set<string>();
  const members = new Set<string>();

  for (const group of groups) {
    workspaces.add(group.orgId);
    members.add(recipientKey(group.orgId, group.userId));
    try {
      await runGroup({ group, recipients, plans, appUrl, now, dryRun, allowDaily, limitEventsPerMember, totals });
    } catch (err) {
      // One member's render failing must not stop the rest of the run. The rows stay where they
      // are — claimed rows are recovered by the stale sweep, unclaimed ones are due next tick.
      if (group.kind === "share_views") totals.views.errors += 1;
      debugError(1, "[notification-emails] group failed", {
        orgId: group.orgId,
        userId: group.userId,
        kind: group.kind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  totals.workspacesProcessed = workspaces.size;
  totals.membersProcessed = members.size;
  return totals;
}

/** One (member, kind) group: resolve the preference, claim what it allows, render, send, mark. */
async function runGroup(params: {
  group: DueGroup;
  recipients: ReadonlyMap<string, Recipient>;
  plans: Map<string, WorkspacePlan>;
  appUrl: string;
  now: Date;
  dryRun: boolean;
  allowDaily: boolean;
  limitEventsPerMember: number;
  totals: SendNotificationEmailsResult;
}): Promise<void> {
  const { group, now, dryRun, totals } = params;
  const { orgId: orgIdStr, userId, kind } = group;
  const orgId = new Types.ObjectId(orgIdStr);
  const recipient = params.recipients.get(recipientKey(orgIdStr, userId));
  const mode = recipient?.modes[kind] ?? "off";

  /** Claim first, then mark: a row another runner already took is not this run's to decide about. */
  const claim = async (limit: number): Promise<ClaimedNotification[]> => {
    const rows = await claimBatch({ orgId, userId, kind, limit, now, dryRun });
    totals.queue.claimed += rows.length;
    return rows;
  };

  // A membership that is gone (or a user with no address) can never be mailed; the rows are a
  // decision, not a backlog, so they are recorded as skipped rather than retried forever.
  //
  // Skipped in one update, without claiming first. This branch never sends, so the claim bought
  // nothing — `skipPending` matches `pending` for exactly this case — and a member with a backlog
  // and every kind on `off` cost a round trip per row, every tick, for mail that is never going
  // out. The count comes from the group, which already counted the due rows.
  if (!recipient || !recipient.email || mode === "off") {
    const reason = !recipient ? "membership removed" : mode === "off" ? "member off" : "no recipient address";
    if (mode === "off" && kind === "share_views") totals.views.off.members += 1;
    totals.queue.skipped += group.due;
    if (!dryRun) await skipPending({ orgId, userId, kind, reason, now });
    return;
  }

  // Decision 6: a `daily` member's rows wait, unclaimed, for the end-of-day UTC tick that groups
  // them into one email, and for that tick only — see `digestAllowedNow`, which is what stops the
  // 23:00-to-midnight window turning into twelve digests. Nothing is written in the meantime.
  if (mode === "daily") {
    const due =
      params.allowDaily && (await digestAllowedNow({ orgId, userId: new Types.ObjectId(userId), kind, now }));
    if (!due) {
      totals.queue.deferred += group.due;
      return;
    }
  }

  if (kind === "share_views" && !/^https?:\/\//i.test(params.appUrl)) {
    // Every link in a view email (the action, the one-click off link, preferences) would be
    // relative and dead in a mail client. Leave the rows pending so they go out once the site URL
    // is configured, rather than burning an attempt on mail nobody can use.
    totals.views.errors += 1;
    totals.queue.deferred += group.due;
    debugError(1, "[notification-emails] no absolute site URL (set NEXT_PUBLIC_SITE_URL); view emails held", {
      orgId: orgIdStr,
    });
    return;
  }

  const rows = await claim(mode === "daily" ? DIGEST_CLAIM_LIMIT : params.limitEventsPerMember);
  if (!rows.length) return;

  try {
    await renderAndSend({ ...params, rows, mode, orgId, membershipId: recipient.membershipId, to: recipient.email });
  } catch (err) {
    // A render that throws is this email failing, not a mystery. Put the rows back on the backoff
    // schedule so a poison row eventually dies with its error on it; left `sending`, they would be
    // re-claimed by the stale sweep every ten minutes forever, attempts never rising. Rows already
    // marked by `deliverRound` do not match its filter, so nothing is written twice. Rethrown so
    // the run logs and counts it.
    for (const row of rows) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) totals.queue.dead += 1;
      else totals.queue.retried += 1;
    }
    if (!dryRun) {
      await markFailed({
        rows: rows.map((r) => ({ id: r.id, attempts: r.attempts })),
        claimToken: claimTokenOf(rows),
        error: err,
        now,
      });
    }
    throw err;
  }
}

/** Render one claimed batch and send it. Split out so a throw here is one member's failure. */
async function renderAndSend(params: {
  group: DueGroup;
  rows: ClaimedNotification[];
  mode: SendMode;
  orgId: Types.ObjectId;
  /** The off link in a view email is signed with the membership, not the user. */
  membershipId: string;
  to: string;
  plans: Map<string, WorkspacePlan>;
  appUrl: string;
  now: Date;
  dryRun: boolean;
  totals: SendNotificationEmailsResult;
}): Promise<void> {
  const { group, rows, mode, orgId, now, dryRun, totals } = params;
  const orgIdStr = group.orgId;
  const kind = group.kind;

  let round: Round;
  if (kind === "share_views") {
    let plan = params.plans.get(orgIdStr);
    if (!plan) {
      plan = "free";
      try {
        plan = (await getWorkspacePlan(orgId)) === "pro" ? "pro" : "free";
      } catch (err) {
        // Unknown plan: fall back to Free so identity can never leak into an email.
        debugError(1, "[notification-emails] plan lookup failed; treating as free", {
          orgId: orgIdStr,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      params.plans.set(orgIdStr, plan);
    }
    round = await buildViewRound({
      orgId,
      rows,
      mode,
      membershipId: params.membershipId,
      appUrl: params.appUrl,
      now,
      plan,
    });
  } else if (kind === "doc_updates") {
    round = await buildDocUpdateRound({ orgId, orgIdStr, rows, mode });
  } else {
    round = await buildRepoLinkRound({ orgId, orgIdStr, rows, mode });
  }

  await deliverRound({
    round,
    to: params.to,
    kind,
    mode,
    orgId: orgIdStr,
    userId: group.userId,
    claimToken: claimTokenOf(rows),
    dryRun,
    now,
    totals,
  });
}
