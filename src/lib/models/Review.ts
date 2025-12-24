import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const reviewSchema = new Schema(
  {
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true, required: true },

    /**
     * Monotonic version within a doc (matches Upload.version).
     */
    version: { type: Number, min: 1, index: true, required: true },

    /**
     * One-time per (docId, version).
     */
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "skipped"],
      default: "queued",
      index: true,
    },

    model: { type: String, trim: true, default: null },

    /**
     * Review prompt inputs (kept bounded; do not store full PDFs).
     */
    prompt: { type: String, default: null },
    inputTextChars: { type: Number, min: 0, default: null },

    /**
     * The generated Markdown review.
     */
    outputMarkdown: { type: String, default: null },

    /**
     * Linkage to prior review context used (if any).
     */
    priorReviewId: { type: Schema.Types.ObjectId, ref: "Review", default: null },
    priorReviewVersion: { type: Number, min: 1, default: null },

    /**
     * Failure/debug info (not exposed to end users).
     */
    error: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Enforce one review per doc version.
reviewSchema.index({ docId: 1, version: 1 }, { unique: true });

export type Review = InferSchemaType<typeof reviewSchema>;

export const ReviewModel: Model<Review> =
  (mongoose.models.Review as Model<Review> | undefined) ??
  mongoose.model<Review>("Review", reviewSchema);



