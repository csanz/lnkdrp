import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * One Slack post owed to one channel (docs/prds/lnkdrp-slack.md, decision 4).
 *
 * A sibling of `NotificationQueue`, not a `channel` field on it: that queue is one row per
 * member and resolves each member's preference at send time; this is one row per connection and
 * the switch was checked when the row was written. The row is written at the event and posted
 * at once from `after()`; a failure leaves it `pending` with backoff for the cron to retry. The
 * unique `dedupeKey` is what makes an event that fires twice post once.
 */
const slackOutboxSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    connectionId: { type: Schema.Types.ObjectId, ref: "SlackConnection", required: true, index: true },
    kind: { type: String, enum: ["views", "briefs", "docUpdates", "requests", "docs"], required: true },
    /** `${kind}:${connectionId}:${sourceId}`; the source is the ShareView, VisitBrief or Upload, or `doc:project:minute` for a filing. */
    dedupeKey: { type: String, required: true, unique: true },
    event: {
      docId: { type: Schema.Types.ObjectId, default: null },
      projectId: { type: Schema.Types.ObjectId, default: null },
      shareId: { type: String, default: null },
      shareViewId: { type: Schema.Types.ObjectId, default: null },
      uploadId: { type: Schema.Types.ObjectId, default: null },
      visitBriefId: { type: Schema.Types.ObjectId, default: null },
      viewerKey: { type: String, default: null },
      viewerName: { type: String, default: null },
      viewerEmail: { type: String, default: null },
      version: { type: Number, default: null },
    },
    occurredAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "sending", "sent", "skipped", "dead"], default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    claimedAt: { type: Date, default: null },
    claimToken: { type: String, default: null },
    lastError: { type: String, default: null, maxlength: 300 },
    sentAt: { type: Date, default: null },
    skippedReason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// The cron's claim: due, pending, oldest first.
slackOutboxSchema.index({ status: 1, nextAttemptAt: 1, occurredAt: 1 });
// The burst cap counts what one connection posted in the last minute.
slackOutboxSchema.index({ connectionId: 1, sentAt: -1 });
// Sent rows are kept a month for the ledger, then go.
slackOutboxSchema.index({ sentAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: "sent" } });

export type SlackOutbox = InferSchemaType<typeof slackOutboxSchema> & {
  _id: mongoose.Types.ObjectId;
  kind: "views" | "briefs" | "docUpdates" | "requests" | "docs";
  status: "pending" | "sending" | "sent" | "skipped" | "dead";
};

export const SlackOutboxModel: Model<SlackOutbox> =
  (mongoose.models.SlackOutbox as Model<SlackOutbox> | undefined) ??
  mongoose.model<SlackOutbox>("SlackOutbox", slackOutboxSchema, "slackoutbox");
