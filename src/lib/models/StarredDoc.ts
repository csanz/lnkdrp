import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * StarredDoc model.
 *
 * Persists a user's "starred documents" for a given org (workspace).
 * The client may also cache starred docs in localStorage for fast UI, but MongoDB is the source of truth.
 */
const starredDocSchema = new Schema(
  {
    /** Organization tenancy boundary (workspace). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, required: true },
    /** User who starred the doc. */
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    /** Starred document id. */
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },
    /** Cached title at the time of starring (best-effort; may be stale). */
    title: { type: String, trim: true, default: "" },
    /**
     * Ordering key (lower sorts earlier).
     * Used for manual reorder in the UI.
     */
    sortKey: { type: Number, default: 0 },
    /** Starred timestamp (best-effort; used for migration/analytics). */
    starredAt: { type: Date, default: () => new Date() },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One star record per (org, user, doc).
starredDocSchema.index({ orgId: 1, userId: 1, docId: 1 }, { unique: true });
// Fast list ordering for the sidebar / starred modal.
starredDocSchema.index({ orgId: 1, userId: 1, sortKey: 1, docId: 1 });

export type StarredDoc = InferSchemaType<typeof starredDocSchema>;

export const StarredDocModel: Model<StarredDoc> =
  (mongoose.models.StarredDoc as Model<StarredDoc> | undefined) ??
  mongoose.model<StarredDoc>("StarredDoc", starredDocSchema, "starredDocs");


