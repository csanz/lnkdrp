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
     * Best-effort viewer IP address (from proxy headers like x-forwarded-for).
     * Note: may be a NAT/proxy IP and can change over time for the same viewer.
     */
    viewerIp: { type: String, trim: true, default: null },
    /**
     * Number of times this viewer downloaded the PDF (best-effort).
     * Only incremented when the receiver hits `/s/:shareId/pdf?download=1`.
     */
    downloads: { type: Number, default: 0, min: 0 },
    /**
     * Downloads keyed by UTC day ("YYYY-MM-DD") so we can build a daily series.
     * Example: { "2025-12-24": 2 }
     */
    downloadsByDay: { type: Map, of: Number, default: {} },
    /**
     * Viewer identity (best-effort):
     * - viewerUserId: present for registered (signed-in) viewers
     * - viewerEmail: present when a viewer provided an email (even if not registered)
     */
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, index: true, default: null },
    /**
     * Denormalized snapshots for fast owner metrics (avoid $lookup into users).
     * These are best-effort and may become stale if a user changes their profile.
     */
    viewerName: { type: String, trim: true, default: null },
    viewerEmailSnapshot: { type: String, trim: true, lowercase: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Uniquely identify a "viewer" (botId) per shareId so we can count unique views.
shareViewSchema.index({ shareId: 1, botIdHash: 1 }, { unique: true });

// Support admin endpoints and rollups that sort/filter by recency.
shareViewSchema.index({ updatedDate: -1 });
shareViewSchema.index({ docId: 1, updatedDate: -1 });
shareViewSchema.index({ docId: 1, createdDate: -1 });

export type ShareView = InferSchemaType<typeof shareViewSchema>;

export const ShareViewModel: Model<ShareView> =
  (mongoose.models.ShareView as Model<ShareView> | undefined) ??
  mongoose.model<ShareView>("ShareView", shareViewSchema);




