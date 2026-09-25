import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * One Slack channel a workspace posts to (docs/prds/lnkdrp-slack.md).
 *
 * A workspace holds any number of these, one per channel, exactly one of them `isDefault`. Each
 * row is what Slack's incoming-webhook install handed back for one channel, plus our own
 * routing (`projectIds`) and switches (`events`). The webhook URL is the secret that lets anyone
 * post into the customer's channel, so it is stored encrypted (`src/lib/slack/crypto.ts`) and
 * never leaves the server.
 */
const slackConnectionSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },

    /** Slack workspace ("team") the channel belongs to. */
    teamId: { type: String, required: true, trim: true },
    teamName: { type: String, required: true, trim: true, maxlength: 200 },

    /** The channel the installer picked on Slack's screen. `channelName` is shown; "#deals". */
    channelId: { type: String, required: true, trim: true },
    channelName: { type: String, required: true, trim: true, maxlength: 200 },

    /** Exactly one per workspace: where events go when no project routes them elsewhere. */
    isDefault: { type: Boolean, default: false },

    /** Projects whose documents post here instead of (not in addition to) the default channel. */
    projectIds: { type: [Schema.Types.ObjectId], default: [] },

    /** `enc.iv.tag`, AES-256-GCM under the HKDF-derived Slack key. Decrypted only to post. */
    webhookUrlEnc: { type: String, required: true },

    /** Slack's page for this webhook, where the customer can remove it on their side. */
    configurationUrl: { type: String, default: null, trim: true },

    installedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /** Per-event switches; off means no outbox row is written for that kind. */
    events: {
      views: { type: Boolean, default: true },
      briefs: { type: Boolean, default: true },
      docUpdates: { type: Boolean, default: true },
      requests: { type: Boolean, default: true },
      /** A document added to a project. Absent on rows written before the switch existed, which reads as on. */
      docs: { type: Boolean, default: true },
    },

    /**
     * `active` posts; `revoked` means Slack told us the webhook is gone (channel deleted, app
     * removed) or five posts in a row failed. A revoked row keeps its identity so the page can say
     * which channel to reconnect.
     */
    status: { type: String, enum: ["active", "revoked"], default: "active", index: true },
    lastPostAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    consecutiveFailures: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One row per channel per workspace: a second install of the same channel updates the row
// (new webhook URL) rather than creating a twin that would post everything twice.
slackConnectionSchema.index({ orgId: 1, channelId: 1 }, { unique: true });

export type SlackConnection = InferSchemaType<typeof slackConnectionSchema> & {
  _id: mongoose.Types.ObjectId;
  status: "active" | "revoked";
};

export const SlackConnectionModel: Model<SlackConnection> =
  (mongoose.models.SlackConnection as Model<SlackConnection> | undefined) ??
  mongoose.model<SlackConnection>("SlackConnection", slackConnectionSchema, "slackconnections");
