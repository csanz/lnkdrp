/**
 * ActivityEvent model.
 *
 * Append-only workspace activity feed: one row per notable write (doc created, upload completed,
 * share settings changed, request submission received, ...). Rows are written best-effort by
 * `recordActivity()` (see `src/lib/activity/log.ts`) after the primary write succeeds and are read
 * by `GET /api/activity` to render the `/activity` page.
 *
 * `title` is denormalized from the doc/project at write time so the feed renders without joins;
 * `agent` records which MCP/agent client performed the action (null for ordinary browsers).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const activityEventSchema = new Schema(
  {
    /** Organization tenancy boundary (the feed is always scoped by org). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Acting user (null for capability-token flows such as request-link uploads). */
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** How the actor authenticated. */
    actorKind: { type: String, enum: ["user", "temp", "secret", "api_key", "viewer"], required: true },
    /** Agent/MCP client attribution (`{ client, version }`), or null for a plain browser. */
    agent: {
      type: new Schema(
        {
          client: { type: String, required: true, trim: true },
          version: { type: String, default: null, trim: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Event type, e.g. `doc.created`, `share.updated` (see `ActivityType`). */
    type: { type: String, required: true, index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },
    /** Denormalized doc/project title for fast rendering. */
    title: { type: String, default: null, trim: true },
    /** Small, type-specific payload (e.g. `{ changed: { shareEnabled: true } }`). */
    meta: { type: Schema.Types.Mixed, default: {} },
    /** Best-effort client IP (first `x-forwarded-for` hop). */
    ip: { type: String, default: null, trim: true },
    createdDate: { type: Date, default: () => new Date() },
  },
  {
    // We manage `createdDate` explicitly; rows are immutable so no `updatedDate`.
    timestamps: false,
    minimize: false,
  },
);

activityEventSchema.index({ orgId: 1, createdDate: -1 });
activityEventSchema.index({ orgId: 1, type: 1, createdDate: -1 });
activityEventSchema.index({ docId: 1, createdDate: -1 });

export type ActivityEvent = InferSchemaType<typeof activityEventSchema>;

export const ActivityEventModel: Model<ActivityEvent> =
  (mongoose.models.ActivityEvent as Model<ActivityEvent> | undefined) ??
  mongoose.model<ActivityEvent>("ActivityEvent", activityEventSchema, "activityevents");
