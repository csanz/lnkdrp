import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * `shareDownloadRequests` collection
 *
 * Represents a receiver-initiated request to download a shared doc when downloads
 * are disabled on the share link. The flow is:
 * - Receiver submits their email on `/s/:shareId`
 * - Owner receives an email with approve/deny links (token-based)
 * - On approval, receiver receives an email with a claim link that requires sign-in
 *   to download or save the doc into their account.
 */
const shareDownloadRequestSchema = new Schema(
  {
    shareId: { type: String, required: true, trim: true, index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", required: true, index: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    requesterEmail: { type: String, required: true, trim: true, lowercase: true, index: true },

    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
      index: true,
    },

    /**
     * Token hash used in owner approval links.
     * (Never store raw tokens.)
     */
    requestTokenHash: { type: String, required: true, unique: true, index: true },

    approvedAt: { type: Date, default: null, index: true },
    deniedAt: { type: Date, default: null, index: true },

    /**
     * Token hash used in receiver claim links (after approval).
     * Sparse unique because it's only present once approved.
     */
    // IMPORTANT: do not default this to null; `null` will participate in unique indexes and break inserts.
    claimTokenHash: { type: String, unique: true, sparse: true, index: true },

    ownerEmailSentAt: { type: Date, default: null },
    ownerEmailError: { type: String, trim: true, default: null },

    requesterEmailSentAt: { type: Date, default: null },
    requesterEmailError: { type: String, trim: true, default: null },

    claimEmailSentAt: { type: Date, default: null },
    claimEmailError: { type: String, trim: true, default: null },

    savedDocId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },
    savedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" }, minimize: false },
);

export type ShareDownloadRequest = InferSchemaType<typeof shareDownloadRequestSchema>;

export const ShareDownloadRequestModel: Model<ShareDownloadRequest> = (() => {
  const existing = mongoose.models.ShareDownloadRequest as Model<ShareDownloadRequest> | undefined;
  if (existing) return existing;
  return mongoose.model<ShareDownloadRequest>("ShareDownloadRequest", shareDownloadRequestSchema);
})();

