import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const uploadSchema = new Schema(
  {
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
    isDeletedDate: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

export type Upload = InferSchemaType<typeof uploadSchema>;

export const UploadModel: Model<Upload> =
  (mongoose.models.Upload as Model<Upload> | undefined) ??
  mongoose.model<Upload>("Upload", uploadSchema);

