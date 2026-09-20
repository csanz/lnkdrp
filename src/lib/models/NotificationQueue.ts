/**
 * NotificationQueue model (docs/prds/lnkdrp-notification-queue.md).
 *
 * One row is **one email owed to one person**, not one event: an event that concerns four members
 * enqueues four rows, so a retry, a preference and a failure are all per recipient. This replaces
 * `NotificationEmailCursor`, where "an email needs to be sent" was never written down and had to be
 * reconstructed at run time by scanning source collections against a high-water mark — which is why
 * a member with no cursor could never be sent their backlog, and why a failed send rewound a cursor
 * instead of retrying one message.
 *
 * Rows are written at the moment the underlying thing happens (best-effort, `void`-style, the same
 * contract as `recordActivity`) and drained by the `notification-emails` cron.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { Types } from "mongoose";

export type NotificationQueueKind = "share_views" | "doc_updates" | "repo_link_requests";

export const NOTIFICATION_QUEUE_KINDS: NotificationQueueKind[] = ["share_views", "doc_updates", "repo_link_requests"];

export type NotificationQueueStatus = "pending" | "sending" | "sent" | "skipped" | "dead";

export const NOTIFICATION_QUEUE_STATUSES: NotificationQueueStatus[] = [
  "pending",
  "sending",
  "sent",
  "skipped",
  "dead",
];

/** `sent` rows expire after 30 days: long enough to answer "did that go out?", bounded all the same. */
const TTL_SECONDS_30_DAYS = 30 * 24 * 60 * 60;

/**
 * Everything the sender needs to render the email without re-deriving it from the source rows.
 *
 * Denormalized on purpose: a document deleted, a link revoked or a reader renamed between the event
 * and the send must not turn a queued email into a crash or a blank. What the row cannot carry
 * (the recipient's current preference, the document's current title) is resolved at send time.
 */
const notificationEventSchema = new Schema(
  {
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    /** Analytics key of the share link (a slug string, as everywhere else — see `ShareView.shareId`). */
    shareId: { type: String, trim: true, default: null },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },
    /** The completed upload that landed in a request repo (`repo_link_requests`). */
    requestId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },

    /** Per-browser viewer digest (`botIdHash`), so the send can tell two anonymous readers apart. */
    viewerKey: { type: String, trim: true, default: null },
    viewerName: { type: String, trim: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, default: null },

    /** Document version this event is about (`doc_updates`). */
    version: { type: Number, default: null },
  },
  { _id: false },
);

const notificationQueueSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** The member who is owed the mail — not the person who caused the event. */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, trim: true, enum: NOTIFICATION_QUEUE_KINDS, required: true },

    /**
     * The whole idempotency story: `<kind>:<userId>:<source row id>`, backed by a unique index.
     * A duplicate insert raises E11000, which the queue reads as "already owed" and swallows, so a
     * retried request, a replayed heartbeat or two racing writers cannot produce two emails.
     */
    dedupeKey: { type: String, trim: true, required: true },

    event: { type: notificationEventSchema, default: () => ({}) },

    /** When the underlying thing happened — the digest sorts and groups on this, not on insert time. */
    occurredAt: { type: Date, required: true },

    status: { type: String, trim: true, enum: NOTIFICATION_QUEUE_STATUSES, required: true, default: "pending" },
    attempts: { type: Number, default: 0, min: 0 },
    /** Not eligible for claiming before this instant; the backoff schedule writes it. */
    nextAttemptAt: { type: Date, required: true, default: () => new Date() },
    /** When a runner claimed the row (`sending`). Older than `CLAIM_STALE_MS` means the runner died. */
    claimedAt: { type: Date, default: null },
    /**
     * Which claim owns the row right now — one token per `claimBatch()` call, cleared on every
     * outcome.
     *
     * `status: "sending"` alone is not ownership: the stale sweep hands a row back without touching
     * `attempts`, so a second runner can re-claim it and a filter of `{status: "sending"}` (or even
     * `{status: "sending", attempts}`) matches the *new* owner's row. The first runner waking up
     * would then mark the second runner's send sent or failed, and the mail goes out twice with
     * nobody able to tell. The token is the only thing that distinguishes the two claims.
     */
    claimToken: { type: String, trim: true, default: null },
    lastError: { type: String, trim: true, default: null },
    sentAt: { type: Date, default: null },
    /** Why this row will never be sent: "member off", "document deleted", … */
    skippedReason: { type: String, trim: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Idempotency. Unique across the whole collection because the key already carries the recipient.
notificationQueueSchema.index({ dedupeKey: 1 }, { unique: true });

// The claim: `{status: "pending", nextAttemptAt: {$lte: now}}`, run once per row per tick.
notificationQueueSchema.index({ status: 1, nextAttemptAt: 1 });

// Digest grouping (every pending row for one member and one kind, oldest first) and the
// "was this member already told?" question, which used to be a cursor comparison.
notificationQueueSchema.index({ orgId: 1, userId: 1, kind: 1, status: 1, occurredAt: 1 });

// Stale-claim recovery: rows left `sending` by a process that died mid-send.
notificationQueueSchema.index({ status: 1, claimedAt: 1 });

// How far behind delivery is, in event time: the admin Emails page and the cron board both ask for
// the oldest pending row, which is a sort and not a count. Without this the sort is done in memory
// over every pending row, which is exactly the backlog case where the answer matters.
notificationQueueSchema.index({ status: 1, occurredAt: 1 });

// "Which members were actually told about this reader?" (`sentNotificationsForViewer`, decision 9).
// The viewer-introduction correction asks this on a live request, so it cannot be a collection scan
// over 30 days of `sent` rows.
notificationQueueSchema.index({ orgId: 1, "event.viewerKey": 1, status: 1 });

// Retention. A TTL index ignores documents whose field is not a date, so only `sent` rows (the only
// ones that carry a `sentAt`) expire — pending, dead and skipped rows stay until someone deals with
// them, which is the point of having a dead state at all.
notificationQueueSchema.index({ sentAt: 1 }, { expireAfterSeconds: TTL_SECONDS_30_DAYS });

export type NotificationQueue = InferSchemaType<typeof notificationQueueSchema> & {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  kind: NotificationQueueKind;
  status: NotificationQueueStatus;
};

const ExistingNotificationQueueModel = mongoose.models.NotificationQueue as Model<NotificationQueue> | undefined;

export const NotificationQueueModel: Model<NotificationQueue> =
  ExistingNotificationQueueModel ?? mongoose.model<NotificationQueue>("NotificationQueue", notificationQueueSchema);

// Dev safety, same as `NotificationEmailCursor`: Next.js hot reload can reuse an already-compiled
// model whose `kind` enum predates a newly added kind, which fails validation on every enqueue until
// the server is restarted. Append what the cached schema is missing (SchemaString#enum appends and
// rebuilds the validator over the full list).
if (ExistingNotificationQueueModel) {
  const kindPath = ExistingNotificationQueueModel.schema.path("kind") as unknown as
    | { enumValues?: string[]; enum?: (...values: string[]) => unknown }
    | undefined;
  const missing = NOTIFICATION_QUEUE_KINDS.filter((k) => !(kindPath?.enumValues ?? []).includes(k));
  if (kindPath && typeof kindPath.enum === "function" && missing.length > 0) {
    kindPath.enum(...missing);
  }
}
