/**
 * NotificationEmailCursor model.
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

export type NotificationEmailCursorKey = "doc_updates" | "repo_link_requests";

const notificationEmailCursorSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    key: { type: String, trim: true, enum: ["doc_updates", "repo_link_requests"], required: true, index: true },

    /**
     * Cursor for the last email send.
     *
     * Interpretation depends on the key:
     * - doc_updates: `DocChange.createdDate`
     * - repo_link_requests: `Upload.updatedDate` for a completed v1 upload into a request repo
     */
    lastNotifiedAt: { type: Date, default: null },

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

export const NotificationEmailCursorModel: Model<NotificationEmailCursor> =
  (mongoose.models.NotificationEmailCursor as Model<NotificationEmailCursor> | undefined) ??
  mongoose.model<NotificationEmailCursor>("NotificationEmailCursor", notificationEmailCursorSchema);

