/**
 * DocChange model.
 *
 * Stores a best-effort "what changed" record whenever a doc upload is replaced
 * (version N → N+1). This is intended for authorized users with access to the doc.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const MAX_SUMMARY_CHARS = 400;

const docChangeSchema = new Schema(
  {
    /** Organization tenancy boundary (used for org switching). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },

    /** The doc this change belongs to. */
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },

    /** Actor that initiated the replacement upload (best-effort). */
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },

    /** Previous/next Upload linkage (best-effort). */
    fromUploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true, default: null },
    toUploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true, required: true },

    /** Previous/next version numbers (matches Upload.version). */
    fromVersion: { type: Number, min: 1, index: true, default: null },
    toVersion: { type: Number, min: 1, index: true, required: true },

    /** Text snapshots (stored so we can inspect/replay diffs later). */
    previousText: { type: String, default: "" },
    newText: { type: String, default: "" },

    /** AI-generated diff summary payload (best-effort). */
    diff: {
      summary: { type: String, trim: true, maxlength: MAX_SUMMARY_CHARS, default: "" },
      changes: {
        type: [
          {
            type: { type: String, trim: true, default: "" },
            title: { type: String, trim: true, default: "" },
            detail: { type: String, trim: true, default: null },
          },
        ],
        default: [],
      },
    },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
    // We want a stable collection name (not mongoose-pluralized) since this is a
    // product-facing concept and is referenced in docs.
    collection: "docChanges",
  },
);

// Enforce one change record per "to" version (replacement upload).
docChangeSchema.index({ docId: 1, toVersion: 1 }, { unique: true });
docChangeSchema.index({ docId: 1, toUploadId: 1 }, { unique: true });

export type DocChange = InferSchemaType<typeof docChangeSchema>;

export const DocChangeModel: Model<DocChange> =
  (mongoose.models.DocChange as Model<DocChange> | undefined) ??
  mongoose.model<DocChange>("DocChange", docChangeSchema);


