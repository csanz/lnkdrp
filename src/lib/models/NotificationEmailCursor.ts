/**
 * NotificationEmailCursor model. DEPRECATED — see docs/prds/lnkdrp-notification-queue.md.
 *
 * Delivery no longer reconstructs "what needs sending" by scanning collections against these
 * high-water marks; `NotificationQueue` records one row per email owed at the moment the event
 * happens (`src/lib/notifications/queue.ts`). The model and its collection stay in the tree for one
 * release so work in flight against them keeps importing, but the send path neither reads nor
 * writes them. "Has this member already been told?" is now `wasNotified()` from that module, and
 * "which members were told about this reader?" is `sentNotificationsForViewer()`; both give an
 * exact answer instead of a timestamp comparison. Nothing reads these rows any more — the last
 * caller (`src/lib/share/anonymousNoticeAudience.ts`) moved to the queue — so a cursor here is
 * frozen at whatever the cursor model left, and is evidence of nothing.
 *
 * Do not add callers. Historical behaviour follows.
 *
 * Stores per-user cursors for background email notifications so cron runs can be:
 * - idempotent (no duplicates)
 * - incremental (only send newly-created events since the last cursor)
 *
 * This intentionally tracks "what we've emailed" separately from `OrgMembership`
 * (which stores only user-facing preferences).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { Types } from "mongoose";

export type NotificationEmailCursorKey = "doc_updates" | "repo_link_requests" | "share_views";

const NOTIFICATION_EMAIL_CURSOR_KEYS: NotificationEmailCursorKey[] = ["doc_updates", "repo_link_requests", "share_views"];

const notificationEmailCursorSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    key: { type: String, trim: true, enum: NOTIFICATION_EMAIL_CURSOR_KEYS, required: true, index: true },

    /**
     * Cursor for the last email send.
     *
     * Interpretation depends on the key:
     * - doc_updates: `DocChange.createdDate`
     * - repo_link_requests: `Upload.updatedDate` for a completed v1 upload into a request repo
     * - share_views: `ShareView.createdDate` for new recipient viewers (returns use
     *   `returnsNotifiedAt` below)
     */
    lastNotifiedAt: { type: Date, default: null },

    /**
     * share_views only: `ShareVisit.createdDate` horizon for returns, which go only in the daily
     * digest. Kept apart from `lastNotifiedAt` because an immediate-mode member moves that every
     * tick, which would otherwise skip returns the digest has not reported yet. Null on cursors
     * written before this field existed; readers fall back to `lastNotifiedAt`, and the first
     * new-viewer advance on such a cursor writes that fallback here so it stops following ticks.
     */
    returnsNotifiedAt: { type: Date, default: null },

    /**
     * UTC day key of the last digest email ("YYYY-MM-DD"), used to avoid sending
     * multiple digests on retries / overlapping schedules.
     */
    lastDigestDay: { type: String, trim: true, default: null, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

notificationEmailCursorSchema.index({ orgId: 1, userId: 1, key: 1 }, { unique: true });

export type NotificationEmailCursor = InferSchemaType<typeof notificationEmailCursorSchema> & {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
};

const ExistingNotificationEmailCursorModel = mongoose.models.NotificationEmailCursor as
  | Model<NotificationEmailCursor>
  | undefined;

export const NotificationEmailCursorModel: Model<NotificationEmailCursor> =
  ExistingNotificationEmailCursorModel ??
  mongoose.model<NotificationEmailCursor>("NotificationEmailCursor", notificationEmailCursorSchema);

// Dev safety: Next.js hot reload can reuse an already-compiled Mongoose model whose `key` enum
// predates newer keys, which would fail validation on upsert until a server restart. Append any
// missing enum values to the cached schema path (SchemaString#enum appends and rebuilds the
// validator over the full list).
if (ExistingNotificationEmailCursorModel) {
  const keyPath = ExistingNotificationEmailCursorModel.schema.path("key") as unknown as
    | { enumValues?: string[]; enum?: (...values: string[]) => unknown }
    | undefined;
  const missing = NOTIFICATION_EMAIL_CURSOR_KEYS.filter((k) => !(keyPath?.enumValues ?? []).includes(k));
  if (keyPath && typeof keyPath.enum === "function" && missing.length > 0) {
    keyPath.enum(...missing);
  }
}
