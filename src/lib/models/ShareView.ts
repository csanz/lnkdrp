import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Per-viewer record for a shared doc, keyed by (shareId, botIdHash).
 * Used to dedupe "views" and to count distinct pages viewed.
 *
 * NOTE: botIdHash is a sha256 hash of a client-generated botId stored in localStorage.
 * We store only the hash to avoid persisting the raw identifier.
 */
const shareViewSchema = new Schema(
  {
    shareId: { type: String, trim: true, index: true, required: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },
    botIdHash: { type: String, trim: true, index: true, required: true },
    pagesSeen: { type: [Number], default: [] },
    /**
     * Viewer identity (best-effort):
     * - viewerUserId: present for registered (signed-in) viewers
     * - viewerEmail: present when a viewer provided an email (even if not registered)
     */
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, index: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Uniquely identify a "viewer" (botId) per shareId so we can count unique views.
shareViewSchema.index({ shareId: 1, botIdHash: 1 }, { unique: true });

export type ShareView = InferSchemaType<typeof shareViewSchema>;

export const ShareViewModel: Model<ShareView> =
  (mongoose.models.ShareView as Model<ShareView> | undefined) ??
  mongoose.model<ShareView>("ShareView", shareViewSchema);




