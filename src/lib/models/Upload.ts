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
     * Optional Blob location for the extracted text artifact.
     * Used for prompt-context payloads (e.g. request guide documents).
     */
    extractedTextBlobUrl: { type: String, trim: true, default: null },
    extractedTextBlobPathname: { type: String, trim: true, default: null },

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

    isDeleted: { type: Boolean, default: false, index: true },
    // New canonical field name (kept alongside `isDeletedDate` for backward-compat).
    deletedDate: { type: Date, default: null },
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

