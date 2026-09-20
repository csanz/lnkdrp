/**
 * The notification queue (docs/prds/lnkdrp-notification-queue.md, M1).
 *
 * Writers call `enqueueNotification()` at the moment something happens; the `notification-emails`
 * cron calls `claimBatch()` and then one of `markSent` / `markFailed` / `markSkipped`. Nothing here
 * sends, renders or reads a preference — a row says only that one person is owed one email.
 *
 * Two contracts split this file in half, and they are deliberately different:
 *
 * - `enqueueNotification()` is a best-effort side effect, the same contract `recordActivity` has.
 *   Callers fire it as `void enqueueNotification({...})` after their primary write. It never throws:
 *   a notification that cannot be recorded must not fail the reading, the upload or the request that
 *   caused it.
 * - Everything else is the cron's primary work. Those throw, because a claim or a mark that failed
 *   silently is how the cursor model lost mail in the first place.
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import {
  NotificationQueueModel,
  type NotificationQueueKind,
  type NotificationQueueStatus,
} from "@/lib/models/NotificationQueue";
import { splitProjectViewerKey } from "@/lib/share/projectPublic";
import { debugError } from "@/lib/debug";

/** Retry delays, indexed by the attempt that just failed (1st failure waits a minute). */
export const BACKOFF_MS: readonly number[] = [
  1 * 60_000, // 1m
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  12 * 60 * 60_000, // 12h
];

/** After this many failed attempts the row is `dead` and is never retried automatically. */
export const MAX_ATTEMPTS = 5;

/** A row left `sending` longer than this belongs to a process that died; it goes back to `pending`. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** Hard ceiling on one claim, whatever the caller asks for: a tick must stay a tick. */
export const MAX_CLAIM_BATCH = 500;

export type NotificationEvent = {
  docId?: string | Types.ObjectId | null;
  projectId?: string | Types.ObjectId | null;
  shareId?: string | null;
  uploadId?: string | Types.ObjectId | null;
  requestId?: string | Types.ObjectId | null;
  viewerKey?: string | null;
  viewerName?: string | null;
  viewerEmail?: string | null;
  version?: number | null;
};

export type EnqueueNotificationInput = {
  orgId: string | Types.ObjectId;
  /** The member who is owed the mail. Fan-out to members happens here, one row each. */
  userId: string | Types.ObjectId;
  kind: NotificationQueueKind;
  /** `<kind>:<userId>:<source row id>` — see `notificationDedupeKey()`. */
  dedupeKey: string;
  event?: NotificationEvent;
  /** When the underlying thing happened; defaults to now. */
  occurredAt?: Date;
  /** Hold the row back until this instant (nothing does yet; the digest groups at send time). */
  notBefore?: Date;
};

export type EnqueueNotificationResult = {
  /** True only when this call wrote a new row. */
  enqueued: boolean;
  /** True when the row was already there (E11000 on `dedupeKey`) — "already owed", not an error. */
  duplicate: boolean;
};

/** One row handed to the sender by `claimBatch()`. */
export type ClaimedNotification = {
  id: string;
  orgId: string;
  userId: string;
  kind: NotificationQueueKind;
  dedupeKey: string;
  event: NotificationEvent;
  occurredAt: Date;
  /** Attempts *before* this one. `markFailed` needs it to place the row on the backoff schedule. */
  attempts: number;
  /** Proof of ownership for this claim; every mark carries it back. Null only on a dry run. */
  claimToken: string | null;
};

/** A row whose send just failed, as `markFailed` wants it: the id plus the attempts it was claimed at. */
export type FailedNotification = { id: string | Types.ObjectId; attempts: number };

export type QueueDepth = {
  pending: number;
  sending: number;
  sent: number;
  skipped: number;
  dead: number;
  total: number;
  /** Pending rows whose `nextAttemptAt` has passed — what the next tick will actually try. */
  due: number;
  /** `occurredAt` of the oldest pending row: how far behind delivery is, in event time. */
  oldestPendingAt: Date | null;
};

/** Scope shared by the claim, the depth summary and the digest queries. */
export type QueueScope = {
  orgId?: string | Types.ObjectId | null;
  userId?: string | Types.ObjectId | null;
  kind?: NotificationQueueKind | null;
};

function toObjectId(v: string | Types.ObjectId | null | undefined): Types.ObjectId | null {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v;
  const s = String(v).trim();
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

/** Mongo raises this when a unique index rejects an insert; here it always means "already owed". */
function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return "code" in err && (err as { code?: unknown }).code === 11000;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err.trim();
  return "Unknown error";
}

/**
 * The dedupe key for one (recipient, source row) pair.
 *
 * Built from the event's own identity rather than from a timestamp or a counter, so the same event
 * re-delivered by a retried request or a replayed heartbeat lands on the same key. `sourceId` is the
 * `ShareView`, the `Upload` or the request upload the notification is about.
 */
export function notificationDedupeKey(
  kind: NotificationQueueKind,
  userId: string | Types.ObjectId,
  sourceId: string | Types.ObjectId,
): string {
  return `${kind}:${String(userId)}:${String(sourceId)}`;
}

/** The delay before the next attempt, given the attempt number that just failed (1-based). */
export function backoffMs(attemptsAfterFailure: number): number {
  // The schedule's last entry is only reachable if MAX_ATTEMPTS is ever raised above its length;
  // clamping rather than wrapping keeps that change a one-line edit instead of a retry storm.
  const i = Math.min(Math.max(Math.floor(attemptsAfterFailure), 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i]!;
}

/** Translate a scope into the filter fragment every queue query shares. */
function scopeFilter(scope: QueueScope | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const orgId = toObjectId(scope?.orgId);
  if (orgId) filter.orgId = orgId;
  const userId = toObjectId(scope?.userId);
  if (userId) filter.userId = userId;
  if (scope?.kind) filter.kind = scope.kind;
  return filter;
}

/**
 * The viewer key as the queue stores it: the **bare digest**, never the `<digest>.<docId>`
 * composite a project link writes (decision 9).
 *
 * Normalised here rather than trusted from the caller. Three bugs this month came from those two
 * shapes being compared literally, and the invariant cannot rest on every future call site
 * remembering which of `viewerBotIdHash` and `botIdHash` it is holding — the document already has
 * its own field on the row.
 */
function normalizeViewerKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return splitProjectViewerKey(trimmed).botIdHash || null;
}

/** Keep only the event fields the schema knows, so a caller's stray key is not silently stored. */
function normalizeEvent(event: NotificationEvent | undefined): Record<string, unknown> {
  const e = event ?? {};
  const name = typeof e.viewerName === "string" ? e.viewerName.trim().slice(0, 300) : null;
  const email = typeof e.viewerEmail === "string" ? e.viewerEmail.trim().toLowerCase().slice(0, 320) : null;
  const version = Number.isFinite(Number(e.version)) ? Number(e.version) : null;
  return {
    docId: toObjectId(e.docId),
    projectId: toObjectId(e.projectId),
    shareId: typeof e.shareId === "string" && e.shareId.trim() ? e.shareId.trim() : null,
    uploadId: toObjectId(e.uploadId),
    requestId: toObjectId(e.requestId),
    viewerKey: normalizeViewerKey(e.viewerKey),
    viewerName: name || null,
    viewerEmail: email || null,
    version,
  };
}

/**
 * Write down that one member is owed one email (best-effort; never throws).
 *
 * The unique `dedupeKey` is the whole idempotency story: a second call with the same key is a
 * no-op, which is what lets call sites drop their ad-hoc "have I already handled this?" guards.
 * The recipient's preference is deliberately NOT read here — a member who turns notifications on
 * today then hears about yesterday, which the cursor model could never do.
 */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<EnqueueNotificationResult> {
  try {
    const orgId = toObjectId(input.orgId);
    const userId = toObjectId(input.userId);
    const dedupeKey = typeof input.dedupeKey === "string" ? input.dedupeKey.trim() : "";
    if (!orgId || !userId || !dedupeKey) {
      debugError(1, "[notifications] enqueue skipped: missing orgId/userId/dedupeKey", {
        kind: input?.kind ?? null,
        dedupeKey: dedupeKey || null,
      });
      return { enqueued: false, duplicate: false };
    }

    const now = new Date();
    await connectMongo();
    await NotificationQueueModel.create({
      orgId,
      userId,
      kind: input.kind,
      dedupeKey,
      event: normalizeEvent(input.event),
      occurredAt: input.occurredAt instanceof Date ? input.occurredAt : now,
      status: "pending",
      attempts: 0,
      nextAttemptAt: input.notBefore instanceof Date ? input.notBefore : now,
      claimedAt: null,
      lastError: null,
      sentAt: null,
      skippedReason: null,
    });
    return { enqueued: true, duplicate: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { enqueued: false, duplicate: true };
    debugError(1, "[notifications] enqueue failed", { kind: input?.kind ?? null, message: errorMessage(err) });
    return { enqueued: false, duplicate: false };
  }
}

export type ClaimBatchParams = QueueScope & {
  /** How many rows to claim, capped at `MAX_CLAIM_BATCH`. */
  limit: number;
  now?: Date;
  /**
   * A dry run reads what it *would* claim and writes nothing — the property that made the
   * 2026-09-19 investigation safe and the reason the CLI stays dry unless `--send` is passed.
   */
  dryRun?: boolean;
};

/**
 * Claim up to `limit` due rows for this runner (`pending -> sending`), oldest due first.
 *
 * Three round trips whatever the batch size — read the candidates, take them, read back what was
 * actually taken — rather than one `findOneAndUpdate` per row. A digest claims up to
 * `MAX_CLAIM_BATCH` rows and the per-row idiom made that up to 500 *serialised* round trips inside
 * a cron tick with a 300s wall clock, which is slower than the bulk cursor writes this replaced.
 *
 * It is still a lock, and for the same reason it always was: `{status: "pending"}` stays in the
 * filter of the `updateMany`, and Mongo applies that filter to each document as it updates it. Two
 * runners that read the same candidate ids cannot both flip one row, because the loser's filter no
 * longer matches by the time it gets there. `claimToken` is then the proof of *which* of them won:
 * the read-back names only this call's rows, and every mark carries the token back so a stalled
 * runner cannot write an outcome over a re-claim (see the field's note on the model).
 *
 * (Decision 4 describes this as a per-row `findOneAndUpdate`. The property that decision is about —
 * a claim is atomic and cannot be handed out twice — is unchanged; only the round-trip count is.)
 */
export async function claimBatch(params: ClaimBatchParams): Promise<ClaimedNotification[]> {
  const now = params.now instanceof Date ? params.now : new Date();
  const limit = Math.min(Math.max(Math.floor(Number(params.limit) || 0), 0), MAX_CLAIM_BATCH);
  if (limit <= 0) return [];

  const filter = { ...scopeFilter(params), status: "pending", nextAttemptAt: { $lte: now } };
  await connectMongo();

  if (params.dryRun) {
    // Read-only path. Same filter and order as the claim, so what a dry run reports is what the
    // next real tick will take, and no row is left `sending` by a run that never sends.
    const rows = await NotificationQueueModel.find(filter)
      .sort({ nextAttemptAt: 1, occurredAt: 1 })
      .limit(limit)
      .lean();
    return rows.map(toClaimed);
  }

  const candidates = await NotificationQueueModel.find(filter)
    .sort({ nextAttemptAt: 1, occurredAt: 1 })
    .limit(limit)
    .select({ _id: 1 })
    .lean();
  const ids = toObjectIds(
    (candidates as Array<{ _id?: unknown }>).map((r) => String(r?._id ?? "")).filter((id) => Types.ObjectId.isValid(id)),
  );
  if (!ids.length) return [];

  const claimToken = new Types.ObjectId().toHexString();
  await NotificationQueueModel.updateMany(
    { ...filter, _id: { $in: ids } },
    { $set: { status: "sending", claimedAt: now, claimToken } },
  );

  // Scoped by `_id` as well as the token so this uses the `_id` index rather than needing one of
  // its own; the token is what makes the answer "the rows this call won", not "the rows that are
  // sending".
  const rows = await NotificationQueueModel.find({ _id: { $in: ids }, claimToken })
    .sort({ nextAttemptAt: 1, occurredAt: 1 })
    .lean();
  return rows.map(toClaimed);
}

type LeanQueueRow = {
  _id: unknown;
  orgId: unknown;
  userId: unknown;
  kind: NotificationQueueKind;
  dedupeKey: string;
  event?: Record<string, unknown> | null;
  occurredAt: Date;
  attempts?: number | null;
  claimToken?: string | null;
};

function toClaimed(row: unknown): ClaimedNotification {
  const r = row as LeanQueueRow;
  const e = (r.event ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (v === null || typeof v === "undefined" ? null : String(v));
  return {
    id: String(r._id),
    orgId: String(r.orgId),
    userId: String(r.userId),
    kind: r.kind,
    dedupeKey: r.dedupeKey,
    event: {
      docId: str(e.docId),
      projectId: str(e.projectId),
      shareId: (e.shareId as string | null) ?? null,
      uploadId: str(e.uploadId),
      requestId: str(e.requestId),
      viewerKey: (e.viewerKey as string | null) ?? null,
      viewerName: (e.viewerName as string | null) ?? null,
      viewerEmail: (e.viewerEmail as string | null) ?? null,
      version: typeof e.version === "number" ? e.version : null,
    },
    occurredAt: r.occurredAt,
    attempts: Number.isFinite(Number(r.attempts)) ? Number(r.attempts) : 0,
    claimToken: typeof r.claimToken === "string" && r.claimToken ? r.claimToken : null,
  };
}

function toObjectIds(ids: ReadonlyArray<string | Types.ObjectId>): Types.ObjectId[] {
  return ids.map(toObjectId).filter((id): id is Types.ObjectId => Boolean(id));
}

/**
 * The token every row in a set shares, or null when they do not share one.
 *
 * A mark covers the rows of one message, and those always come from one `claimBatch()` call, so
 * this is normally just "the token". Null (a dry run, or a row written before claim tokens existed)
 * falls back to the weaker `{status: "sending"}` filter rather than matching nothing.
 */
export function claimTokenOf(rows: ReadonlyArray<{ claimToken?: string | null }>): string | null {
  const first = rows[0]?.claimToken ?? null;
  if (!first) return null;
  return rows.every((r) => r.claimToken === first) ? first : null;
}

/** Restrict a mark to the rows this claim still owns. See `claimToken` on the model. */
function ownedFilter(_ids: Types.ObjectId[], claimToken: string | null | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: { $in: _ids }, status: "sending" };
  if (claimToken) filter.claimToken = claimToken;
  return filter;
}

/**
 * The mail went out. One call marks a whole digest sent, because a digest is one email for many rows.
 *
 * Only rows this claim still owns are marked. `status: "sending"` alone is not ownership — the
 * stale sweep can hand a row back and another runner can re-claim it, which leaves it `sending`
 * again — so the claim's token is part of the filter and a stalled runner's late `markSent` writes
 * nothing.
 */
export async function markSent(params: {
  ids: ReadonlyArray<string | Types.ObjectId>;
  /** From `claimTokenOf(rows)`. Omitted, this falls back to marking any `sending` row. */
  claimToken?: string | null;
  now?: Date;
}): Promise<number> {
  const _ids = toObjectIds(params.ids);
  if (_ids.length === 0) return 0;
  await connectMongo();
  const res = await NotificationQueueModel.updateMany(ownedFilter(_ids, params.claimToken), {
    $set: {
      status: "sent",
      sentAt: params.now instanceof Date ? params.now : new Date(),
      claimedAt: null,
      claimToken: null,
      lastError: null,
    },
  });
  return res.modifiedCount ?? 0;
}

/**
 * Hand rows back unsent, with no attempt spent and no error recorded.
 *
 * Used when a claim took more than the message could carry: a view digest renders at most
 * `DIGEST_MAX_DOCUMENTS` documents, and the rows beyond that were never in any email. Marking them
 * `sent` would make `wasNotified()` answer "yes, they were told" about documents the recipient was
 * never told about; leaving them `sending` would hide them until the stale sweep. Back to `pending`
 * and due now is the only honest outcome — they roll into the next tick.
 */
export async function releaseClaims(params: {
  ids: ReadonlyArray<string | Types.ObjectId>;
  claimToken?: string | null;
  now?: Date;
}): Promise<number> {
  const _ids = toObjectIds(params.ids);
  if (_ids.length === 0) return 0;
  await connectMongo();
  const res = await NotificationQueueModel.updateMany(ownedFilter(_ids, params.claimToken), {
    $set: {
      status: "pending",
      nextAttemptAt: params.now instanceof Date ? params.now : new Date(),
      claimedAt: null,
      claimToken: null,
    },
  });
  return res.modifiedCount ?? 0;
}

export type MarkFailedResult = {
  /** Rows put back to `pending` with a later `nextAttemptAt`. */
  retried: number;
  /** Rows that used up `MAX_ATTEMPTS` and became `dead`. */
  dead: number;
};

/**
 * The send threw. Advance the row along the backoff schedule, or give up and say so.
 *
 * `attempts` comes from the claimed row rather than from `$inc`, and is part of the filter, so a
 * row is placed on the schedule it was claimed at. Rows are grouped by that count so a failed
 * digest of forty rows is one or two updates, not forty.
 *
 * Ownership is the claim's token, not the attempt count: `recoverStaleClaims` deliberately does not
 * increment attempts, so after a hand-back and a re-claim the count is unchanged and `{status:
 * "sending", attempts}` matches the *new* owner's row.
 *
 * Giving up is a state, not a drop: `dead` keeps `lastError` and shows up on the admin Emails page,
 * because a queue that silently loses mail is the thing being replaced.
 */
export async function markFailed(params: {
  rows: ReadonlyArray<FailedNotification>;
  error: unknown;
  /** From `claimTokenOf(rows)`. Omitted, this falls back to any `sending` row at that count. */
  claimToken?: string | null;
  now?: Date;
}): Promise<MarkFailedResult> {
  const now = params.now instanceof Date ? params.now : new Date();
  const lastError = errorMessage(params.error).slice(0, 1000);

  /** attempts-at-claim -> the ids that were claimed at that count. */
  const byAttempts = new Map<number, Types.ObjectId[]>();
  for (const row of params.rows) {
    const _id = toObjectId(row.id);
    if (!_id) continue;
    const attempts = Number.isFinite(Number(row.attempts)) ? Math.max(Math.floor(Number(row.attempts)), 0) : 0;
    const bucket = byAttempts.get(attempts);
    if (bucket) bucket.push(_id);
    else byAttempts.set(attempts, [_id]);
  }
  if (byAttempts.size === 0) return { retried: 0, dead: 0 };

  await connectMongo();
  let retried = 0;
  let dead = 0;
  for (const [attempts, _ids] of byAttempts) {
    const next = attempts + 1;
    const isDead = next >= MAX_ATTEMPTS;
    const res = await NotificationQueueModel.updateMany(
      { ...ownedFilter(_ids, params.claimToken), attempts },
      {
        $set: {
          status: isDead ? "dead" : "pending",
          attempts: next,
          // A dead row keeps a `nextAttemptAt` in the past on purpose: it is not scheduled, and an
          // admin retry only has to reset `status` and `attempts` for it to be due immediately.
          nextAttemptAt: isDead ? now : new Date(now.getTime() + backoffMs(next)),
          claimedAt: null,
          claimToken: null,
          lastError,
        },
      },
    );
    const n = res.modifiedCount ?? 0;
    if (isDead) dead += n;
    else retried += n;
  }
  return { retried, dead };
}

/**
 * This email will never be sent, and why.
 *
 * Used when the recipient's preference is `off` at send time, or when the thing the email is about
 * no longer exists. Rows are marked rather than deleted so the decision stays on the record —
 * "nothing was sent" and "nothing was owed" are different answers to the same question.
 */
export async function markSkipped(params: {
  ids: ReadonlyArray<string | Types.ObjectId>;
  reason: string;
  /** From `claimTokenOf(rows)` when these ids came from a claim; see `markSent`. */
  claimToken?: string | null;
  now?: Date;
}): Promise<number> {
  const _ids = toObjectIds(params.ids);
  if (_ids.length === 0) return 0;
  const reason = (params.reason ?? "").trim().slice(0, 300) || "skipped";
  await connectMongo();
  const res = await NotificationQueueModel.updateMany(
    params.claimToken
      ? ownedFilter(_ids, params.claimToken)
      : // Pending rows too: an id list that did not come from a claim is a backlog being decided
        // about, not a send being recorded.
        { _id: { $in: _ids }, status: { $in: ["pending", "sending"] } },
    { $set: { status: "skipped", skippedReason: reason, claimedAt: null, claimToken: null } },
  );
  return res.modifiedCount ?? 0;
}

/**
 * Skip a whole due backlog in one update, without claiming it first.
 *
 * For the decision that is made about a member rather than about a message: their preference is
 * `off`, their membership is gone, they have no address. Claiming those rows first bought nothing
 * — `markSkipped` matches `pending` on purpose — and cost one round trip per row, every tick, for
 * a member who is never going to be mailed.
 *
 * `{status: "pending"}` is still the lock: a row another runner has already claimed is `sending`
 * and is that runner's to decide about, not this one's.
 */
export async function skipPending(params: {
  orgId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  kind: NotificationQueueKind;
  reason: string;
  now?: Date;
}): Promise<number> {
  const now = params.now instanceof Date ? params.now : new Date();
  const scope = scopeFilter(params);
  if (!scope.orgId || !scope.userId || !scope.kind) return 0;
  const reason = (params.reason ?? "").trim().slice(0, 300) || "skipped";
  await connectMongo();
  const res = await NotificationQueueModel.updateMany(
    { ...scope, status: "pending", nextAttemptAt: { $lte: now } },
    { $set: { status: "skipped", skippedReason: reason, claimedAt: null, claimToken: null } },
  );
  return res.modifiedCount ?? 0;
}

/**
 * Hand back rows claimed by a run that died mid-send (`sending` for longer than `CLAIM_STALE_MS`).
 *
 * Attempts are deliberately not incremented: nobody knows whether the mail went out, and a crash is
 * not evidence that this row is the poison one. `nextAttemptAt` is reset to now so a recovered row
 * is due on the next tick — the alternative is a row stuck `sending` forever.
 */
export async function recoverStaleClaims(params?: { now?: Date; staleMs?: number }): Promise<number> {
  const now = params?.now instanceof Date ? params.now : new Date();
  const staleMs = Number.isFinite(Number(params?.staleMs)) ? Number(params?.staleMs) : CLAIM_STALE_MS;
  const staleBefore = new Date(now.getTime() - staleMs);
  await connectMongo();
  const res = await NotificationQueueModel.updateMany(
    { status: "sending", claimedAt: { $lt: staleBefore } },
    // The token goes with the claim: once the row is handed back, the runner that was holding it
    // owns nothing, and its late `markSent` / `markFailed` must not match the next claim's row.
    { $set: { status: "pending", nextAttemptAt: now, claimedAt: null, claimToken: null } },
  );
  return res.modifiedCount ?? 0;
}

/**
 * Has this member already been told?
 *
 * The queue-backed replacement for comparing a timestamp against `NotificationEmailCursor`
 * (decision 7). With a `dedupeKey` the answer is exact — that one email, sent or not. With a
 * `before` it is the cursor question asked properly: was anything of this kind, for an event at or
 * before that instant, actually sent to this person.
 */
export async function wasNotified(params: {
  orgId?: string | Types.ObjectId | null;
  userId?: string | Types.ObjectId | null;
  kind?: NotificationQueueKind | null;
  before?: Date | null;
  /** Ask about one specific event instead of a window. */
  dedupeKey?: string | null;
}): Promise<boolean> {
  await connectMongo();

  if (params.dedupeKey) {
    const row = await NotificationQueueModel.findOne({ dedupeKey: params.dedupeKey })
      .select({ status: 1 })
      .lean();
    return (row as { status?: NotificationQueueStatus } | null)?.status === "sent";
  }

  const filter: Record<string, unknown> = { ...scopeFilter(params), status: "sent" };
  if (params.before instanceof Date) filter.occurredAt = { $lte: params.before };
  const hit = await NotificationQueueModel.findOne(filter).select({ _id: 1 }).lean();
  return Boolean(hit);
}

/**
 * Which members have actually been told about this reader, and when (decision 9).
 *
 * `status: "sent"` only — not enqueued, not claimed, not failed, not a high-water mark that swept
 * past. The caller's premise (`src/lib/share/anonymousNoticeAudience.ts`) is that a specific wrong
 * email is sitting in a specific inbox, so anything short of delivered is not evidence.
 *
 * Per member rather than a single boolean, deliberately: where one member is on `immediate` and
 * another on `daily`, the first has been told and the second has not, and treating them the same
 * means mailing somebody about something they are about to be told properly anyway.
 *
 * The key is matched as the bare digest, the shape `normalizeViewerKey` stores, so a caller holding
 * a project link's `<digest>.<docId>` composite gets the right answer rather than none.
 */
export async function sentNotificationsForViewer(params: {
  orgId: string | Types.ObjectId;
  viewerKey: string;
}): Promise<Array<{ userId: string; sentAt: Date | null }>> {
  const orgId = toObjectId(params.orgId);
  const viewerKey = normalizeViewerKey(params.viewerKey);
  if (!orgId || !viewerKey) return [];

  await connectMongo();
  const rows = (await NotificationQueueModel.find({
    orgId,
    "event.viewerKey": viewerKey,
    kind: "share_views",
    status: "sent",
  })
    .select({ userId: 1, sentAt: 1 })
    .lean()) as Array<{ userId?: unknown; sentAt?: Date | null }>;

  // One entry per member, carrying their most recent send: a reader who opened four documents has
  // four rows per member, and the caller is asking about the person, not the readings.
  const latest = new Map<string, Date | null>();
  for (const row of rows) {
    const userId = row?.userId ? String(row.userId) : "";
    if (!Types.ObjectId.isValid(userId)) continue;
    const sentAt = row.sentAt instanceof Date ? row.sentAt : null;
    const seen = latest.get(userId);
    if (!latest.has(userId) || (sentAt && (!seen || sentAt > seen))) latest.set(userId, sentAt);
  }
  return Array.from(latest, ([userId, sentAt]) => ({ userId, sentAt }));
}

/**
 * What is waiting, what went out, what gave up — the question the cursor model could not answer.
 *
 * Counts rather than a `$group` over the collection. The aggregate this replaces read every
 * document to bucket it by status, on every load of `/a/emails` and `/a/cron-health`, against a
 * collection that holds 30 days of `sent` rows fanned out one per member per event. Each count
 * here is served by an index prefix (`{status, nextAttemptAt}`), and the oldest pending row is a
 * one-document read off `{status, occurredAt}`.
 */
export async function queueDepth(params?: QueueScope & { now?: Date }): Promise<QueueDepth> {
  const now = params?.now instanceof Date ? params.now : new Date();
  await connectMongo();
  const scope = scopeFilter(params);

  const countOf = (status: NotificationQueueStatus): Promise<number> =>
    NotificationQueueModel.countDocuments({ ...scope, status });

  const [pending, sending, sent, skipped, dead, due, oldest] = await Promise.all([
    countOf("pending"),
    countOf("sending"),
    countOf("sent"),
    countOf("skipped"),
    countOf("dead"),
    NotificationQueueModel.countDocuments({ ...scope, status: "pending", nextAttemptAt: { $lte: now } }),
    NotificationQueueModel.find({ ...scope, status: "pending" })
      .sort({ occurredAt: 1 })
      .limit(1)
      .select({ occurredAt: 1 })
      .lean(),
  ]);

  const oldestRow = (oldest as Array<{ occurredAt?: Date | null }> | null)?.[0];
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    pending: n(pending),
    sending: n(sending),
    sent: n(sent),
    skipped: n(skipped),
    dead: n(dead),
    total: n(pending) + n(sending) + n(sent) + n(skipped) + n(dead),
    due: n(due),
    oldestPendingAt: oldestRow?.occurredAt instanceof Date ? oldestRow.occurredAt : null,
  };
}
