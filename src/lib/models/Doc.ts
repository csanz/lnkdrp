import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const docSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, default: null },
    /**
     * Multi-project support:
     * A doc can belong to many projects. `projectId` remains as a backward-compat
     * "primary" pointer, while `projectIds` is the canonical membership list.
     */
    projectIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
      index: true,
      default: [],
    },
    // Backward-compat: some older code refers to `uploadId`
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true },
    // New canonical field name
    currentUploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true },

    /**
     * Canonical object status.
     */
    status: {
      type: String,
      enum: ["draft", "preparing", "ready", "failed"],
      default: "draft",
      index: true,
    },

    /**
     * Public share identifier (safe for URLs).
     * Used for share links like `/share/:shareId` so we never expose Mongo `_id`.
     */
    shareId: { type: String, trim: true, index: true, unique: true },

    title: { type: String, trim: true },

    /**
     * Separate "document name" (AI-inferred) vs. file name.
     * - docName: inferred from the document content (not the upload filename).
     * - fileName: last uploaded filename (denormalized from Upload.originalFileName).
     */
    docName: { type: String, trim: true },
    fileName: { type: String, trim: true },

    // Canonical pointers to current artifacts
    blobUrl: { type: String, trim: true },
    previewImageUrl: { type: String, trim: true },
    extractedText: { type: String },

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

    numberOfViews: { type: Number, default: 0, min: 0 },
    numberOfPagesViewed: { type: Number, default: 0, min: 0 },
    // Backward-compat artifact fields (older code)
    firstPagePngUrl: { type: String, trim: true }, // (vercel blob URL)

    // Optional (often derived from Upload, but handy to denormalize)
    // Backward-compat extracted text field
    pdfText: { type: String },

    /**
     * Share-page UX option:
     * If true, the receiver sees a simple "relevance checklist" UI on `/share/:shareId`.
     */
    receiverRelevanceChecklist: { type: Boolean, default: false },

    /**
     * Share-page UX option:
     * If true, show a "Download PDF" button to receivers on `/s/:shareId`.
     *
     * Note: This does not prevent a motivated receiver from saving what they can view,
     * but it controls whether we present an explicit download affordance.
     */
    shareAllowPdfDownload: { type: Boolean, default: false },

    /**
     * Optional password protection for `/share/:shareId`.
     *
     * - Never store plaintext passwords.
     * - When `sharePasswordHash` is present, the share page is gated behind a password.
     */
    sharePasswordSalt: { type: String, default: null },
    sharePasswordHash: { type: String, default: null },
    // Encrypted (reversible) form for owners to view/edit the current password.
    // This is encrypted server-side using a secret and is never exposed publicly.
    sharePasswordEnc: { type: String, default: null },
    sharePasswordEncIv: { type: String, default: null },
    sharePasswordEncTag: { type: String, default: null },

    isArchived: { type: Boolean, default: false, index: true },
    archivedDate: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    isDeletedDate: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

export type Doc = InferSchemaType<typeof docSchema>;

export const DocModel: Model<Doc> = (() => {
  const existing = mongoose.models.Doc as Model<Doc> | undefined;
  if (existing) {
    // In dev, Next/Mongoose can keep an old cached model across edits.
    // If the cached model is missing newer schema paths, rebuild it so updates persist.
    const hasSharePassword =
      Boolean(existing.schema.path("sharePasswordHash")) &&
      Boolean(existing.schema.path("sharePasswordSalt")) &&
      Boolean(existing.schema.path("sharePasswordEnc")) &&
      Boolean(existing.schema.path("sharePasswordEncIv")) &&
      Boolean(existing.schema.path("sharePasswordEncTag"));
    const hasProjectIds = Boolean(existing.schema.path("projectIds"));
    const hasShareAllowPdfDownload = Boolean(existing.schema.path("shareAllowPdfDownload"));
    if (
      (!hasSharePassword || !hasProjectIds || !hasShareAllowPdfDownload) &&
      process.env.NODE_ENV !== "production"
    ) {
      delete mongoose.models.Doc;
    } else {
      return existing;
    }
  }
  return mongoose.model<Doc>("Doc", docSchema);
})();

