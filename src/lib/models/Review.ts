/**
 * Review model.
 *
 * Stores AI-generated review output (markdown + structured "intel") for a doc upload
 * version. Reviews are unique per `(docId, version)`.
 */
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
     * New request-review agent outputs (Guide vs Deck relevancy).
     *
     * These fields are used by request repos. We keep them separate from the legacy
     * `intel` structure so we can evolve schemas without breaking older records.
     */
    agentKind: { type: String, trim: true, default: null },
    agentSystemPrompt: { type: String, default: null },
    agentUserPrompt: { type: String, default: null },
    agentRawOutputText: { type: String, default: null },
    agentOutput: { type: Schema.Types.Mixed, default: null },

    /**
     * The generated Markdown review.
     */
    outputMarkdown: { type: String, default: null },

    /**
     * Structured "Intel" extracted by the review agent (owner-only UI).
     *
     * This complements `outputMarkdown` so the UI can render consistent fields
     * (company/contact + score + strengths/risks/recommendations) without parsing text.
     */
    intel: {
      company: {
        name: { type: String, trim: true, default: null },
        url: { type: String, trim: true, default: null },
      },
      contact: {
        name: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null },
        url: { type: String, trim: true, default: null },
      },
      overallAssessment: { type: String, trim: true, default: null },
      effectivenessScore: { type: Number, min: 0, max: 10, default: null },
      scoreRationale: { type: String, trim: true, default: null },
      strengths: {
        type: [{ title: { type: String, trim: true }, detail: { type: String, trim: true, default: null } }],
        default: [],
      },
      weaknessesAndRisks: {
        type: [{ title: { type: String, trim: true }, detail: { type: String, trim: true, default: null } }],
        default: [],
      },
      recommendations: {
        type: [{ title: { type: String, trim: true }, detail: { type: String, trim: true, default: null } }],
        default: [],
      },
      actionItems: {
        type: [{ title: { type: String, trim: true }, detail: { type: String, trim: true, default: null } }],
        default: [],
      },
      /**
       * Not shown to receivers; requester-only.
       */
      suggestedRewrites: { type: String, default: null },
    },

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




