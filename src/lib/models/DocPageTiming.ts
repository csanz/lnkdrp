/**
 * DocPageTiming model.
 *
 * Stores per-user timing on a specific document page (slide) for an internal doc version.
 * Used to answer:
 * - Did a member open the updated version? (any record exists for docId+version+viewerUserId)
 * - Which pages did they view? (distinct pageNumber)
 * - How long did they spend per page? (sum durationMs)
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const docPageTimingSchema = new Schema(
  {
    /** Organization tenancy boundary. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },

    /** Doc linkage. */
    docId: { type: Schema.Types.ObjectId, ref: "Doc", required: true, index: true },

    /** Upload version (matches Upload.version / Doc.currentUploadVersion). */
    version: { type: Number, required: true, min: 1, index: true },

    /** Viewer identity (internal member). */
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /** Hash of per-tab session id (matches metrics/events). */
    sessionIdHash: { type: String, required: true, index: true, trim: true },

    /** 1-indexed PDF page/slide number. */
    pageNumber: { type: Number, required: true, min: 1, index: true },

    enteredAt: { type: Date, required: true },
    leftAt: { type: Date, required: true },
    durationMs: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Common query patterns:
docPageTimingSchema.index({ docId: 1, version: 1, viewerUserId: 1, createdDate: -1 });
docPageTimingSchema.index({ docId: 1, version: 1, pageNumber: 1, createdDate: -1 });

export type DocPageTiming = InferSchemaType<typeof docPageTimingSchema>;

export const DocPageTimingModel: Model<DocPageTiming> =
  (mongoose.models.DocPageTiming as Model<DocPageTiming> | undefined) ??
  mongoose.model<DocPageTiming>("DocPageTiming", docPageTimingSchema);


