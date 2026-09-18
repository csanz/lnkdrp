/**
 * Upload model.
 *
 * Represents a single upload attempt for a doc, including pipeline status and
 * links to Blob artifacts (PDF, preview image, extracted text).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const uploadSchema = new Schema(
  {
    /** Organization tenancy boundary (used for org switching). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true },

    /**
     * Monotonic version within a doc (1 = first upload, 2+ = re-uploads).
     */
    version: { type: Number, min: 1, index: true },

    /**
     * Append-only event record status (pipeline).
     */
    status: {
      type: String,
      enum: ["uploading", "uploaded", "processing", "completed", "failed"],
      default: "uploading",
      index: true,
    },

    /**
     * When the current `processing` run claimed this upload.
     *
     * Used to make the `uploaded|failed -> processing` transition atomic and to let a run
     * that got stuck in `processing` (crashed worker, timeout) become eligible again.
     */
    processingStartedAt: { type: Date, default: null },

    originalFileName: { type: String, trim: true },
    contentType: { type: String, trim: true },
    sizeBytes: { type: Number, min: 0 },

    blobUrl: { type: String, trim: true },
    blobPathname: { type: String, trim: true, index: true },

    /**
     * Optional secret that authorizes updating/processing this upload without a user session.
     * Used for "request upload links" where recipients upload into the owner's account.
     */
    uploadSecret: { type: String, trim: true, default: null },

    /**
     * Optional flag to skip the review agent for this upload.
     * Used for "request guide documents" (thesis/RFP/JD) so they don't generate reviews themselves.
     */
    skipReview: { type: Boolean, default: false },

    /**
     * Separate "document name" (AI-inferred) vs. file name.
     * - docName: inferred from the document content (not the upload filename).
     */
    docName: { type: String, trim: true },

    // Derived data
    // - keep existing field names for backward compat
    pdfText: { type: String },
    firstPagePngUrl: { type: String, trim: true }, // (vercel blob URL)
    // - new preferred names
    rawExtractedText: { type: String },
    previewImageUrl: { type: String, trim: true }, // (vercel blob URL)

    /**
     * What the AI steps did on this version and why, written by the processing job:
     * `{ summary, compare, reason, code, creditsNeeded, creditsUsed, source }` where `summary` is
     * `done|skipped|failed`, `compare` is `done|skipped|failed|not_applicable`, `code` is
     * `out_of_credits|daily_cap|plan|recipient|error|null` and `source` is `owner|recipient`.
     * Returned as `ai` by `GET /api/uploads/:id` so the UI can explain a missing summary.
     */
    ai: { type: Schema.Types.Mixed, default: null },

    /**
     * Summary written by the uploading agent (`{ summary, keyPoints, client, label }`), validated by
     * `parseAgentSummaryInput`. When set, processing skips the AI summary and records 0 credits.
     */
    agentSummary: { type: Schema.Types.Mixed, default: null },

    /**
     * Set while a "write the summary again" run is queued (`POST /api/uploads/:id/summary` or the
     * monthly re-queue): processing re-runs only the summary, never the compare, and clears it.
     */
    summaryRerun: { type: Boolean, default: false },
    /** Number of summary reruns requested; part of the rerun's credit idempotency key. */
    summaryRerunCount: { type: Number, default: 0 },

    /**
     * Optional Blob location for the extracted text artifact.
     * Used for prompt-context payloads (e.g. request guide documents).
     */
    extractedTextBlobUrl: { type: String, trim: true, default: null },
    extractedTextBlobPathname: { type: String, trim: true, default: null },

    /**
     * Where this run has got to, written at the real boundaries of the pipeline (see
     * `src/lib/uploads/progress.ts`) and throttled to roughly one write per 750ms.
     *
     * `percent` is 0–100, `stage` is the sentence a person or an agent reads ("rendering page 3 of
     * 9"), `stageKey` is the machine-readable half. `orgId`/`docId` are stamped here so the
     * realtime server can route the frame to a workspace room straight off the change stream
     * without a second query per page.
     */
    progress: {
      percent: { type: Number, min: 0, max: 100, default: null },
      stage: { type: String, trim: true, default: null },
      stageKey: { type: String, trim: true, default: null },
      orgId: { type: Schema.Types.ObjectId, ref: "Org", default: null },
      docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null },
      updatedAt: { type: Date, default: null },
    },

    /**
     * Retryable derived metadata.
     */
    metadata: {
      pages: { type: Number, min: 0 },
      size: { type: Number, min: 0 },
      checksum: { type: String, trim: true },
    },

    /**
     * Failure/debug info (not exposed to end users).
     */
    error: { type: Schema.Types.Mixed, default: null },

    // AI results (store JSON like public/sample/sample-ai-output.json)
    aiOutput: { type: Schema.Types.Mixed, default: null },

    // AI-derived per-page slugs (kebab-case)
    pageSlugs: {
      type: [
        {
          pageNumber: { type: Number, min: 1 },
          slug: { type: String, trim: true, default: null },
        },
      ],
      default: [],
    },

    /**
     * Per-page (slide) nodes for this upload version.
     *
     * Stored on Upload so history versions retain their own slide thumbnails/images.
     * Doc also denormalizes the latest upload's nodes for convenience.
     */
    slideNodes: {
      type: [
        {
          pageNumber: { type: Number, min: 1 },
          /** Public blob URL to a medium/large slide image (JPEG). */
          imageUrl: { type: String, trim: true, default: null },
          /** Public blob URL to a smaller slide thumbnail (JPEG). */
          thumbUrl: { type: String, trim: true, default: null },
          /** Exact hash of the normalized thumbnail pixels: differs on every re-encode. */
          imageHash: { type: String, trim: true, default: null },
          /**
           * Perceptual fingerprint (dHash hex) of the same thumbnail, added 2026-09-18. Survives a
           * re-encode of the same picture, which `imageHash` does not - see
           * `@/lib/history/pageFingerprint`. Null on uploads processed before that.
           */
          imageFingerprint: { type: String, trim: true, default: null },
          width: { type: Number, min: 0, default: null },
          height: { type: Number, min: 0, default: null },
        },
      ],
      default: [],
    },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedDate: { type: Date, default: null },
    // Legacy field; no longer written. Kept in schema for existing documents.
    isDeletedDate: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

export type Upload = InferSchemaType<typeof uploadSchema>;

const ExistingUploadModel = mongoose.models.Upload as Model<Upload> | undefined;

export const UploadModel: Model<Upload> =
  ExistingUploadModel ?? mongoose.model<Upload>("Upload", uploadSchema);

// Dev safety: Next.js hot reload can reuse an already-compiled Mongoose model, which means
// schema additions made during development may not take effect until a server restart.
// If the cached model is missing newer fields (like `uploadSecret`), patch them in so
// capability flows (/doc/update, /r/:token uploads) don't silently drop secrets.
if (ExistingUploadModel && !ExistingUploadModel.schema.path("uploadSecret")) {
  ExistingUploadModel.schema.add({
    uploadSecret: { type: String, trim: true, default: null },
  } as any);
}
if (ExistingUploadModel && !ExistingUploadModel.schema.path("ai")) {
  ExistingUploadModel.schema.add({
    ai: { type: Schema.Types.Mixed, default: null },
  } as any);
}
if (ExistingUploadModel && !ExistingUploadModel.schema.path("agentSummary")) {
  ExistingUploadModel.schema.add({
    agentSummary: { type: Schema.Types.Mixed, default: null },
    summaryRerun: { type: Boolean, default: false },
    summaryRerunCount: { type: Number, default: 0 },
  } as any);
}
if (ExistingUploadModel && !ExistingUploadModel.schema.path("processingStartedAt")) {
  ExistingUploadModel.schema.add({
    processingStartedAt: { type: Date, default: null },
  } as any);
}
if (ExistingUploadModel && !ExistingUploadModel.schema.path("progress.percent")) {
  ExistingUploadModel.schema.add({
    progress: {
      percent: { type: Number, min: 0, max: 100, default: null },
      stage: { type: String, trim: true, default: null },
      stageKey: { type: String, trim: true, default: null },
      orgId: { type: Schema.Types.ObjectId, ref: "Org", default: null },
      docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null },
      updatedAt: { type: Date, default: null },
    },
  } as any);
}

