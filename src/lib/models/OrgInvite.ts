/**
 * Org invite model.
 *
 * Used to invite a user into an org via a one-time token (invite link).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const orgInviteSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** sha256(token) */
    tokenHash: { type: String, trim: true, required: true, unique: true, index: true },
    /**
     * Optional recipient email for email-sent invites.
     * (Invite redemption is still token-based; this is for admin UX / auditability.)
     */
    recipientEmail: { type: String, trim: true, lowercase: true, default: null },
    /**
     * Encrypted invite token material (AES-256-GCM), allowing admins to re-copy an invite link later
     * without storing plaintext tokens in Mongo.
     */
    tokenEnc: { type: String, default: null },
    tokenEncIv: { type: String, default: null },
    tokenEncTag: { type: String, default: null },
    /** Default role granted to the invited user. */
    role: { type: String, trim: true, required: true, enum: ["admin", "member", "viewer"], default: "member" },
    expiresAt: { type: Date, required: true, index: true },
    isRevoked: { type: Boolean, default: false, index: true },
    redeemedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    redeemedAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Performance: listing invites in Teams tab:
// OrgInvite.find({ orgId, isRevoked: { $ne: true } }).sort({ createdDate: -1 }).limit(25)
orgInviteSchema.index(
  { orgId: 1, createdDate: -1 },
  { partialFilterExpression: { isRevoked: { $ne: true } } },
);

export type OrgInvite = InferSchemaType<typeof orgInviteSchema>;

export const OrgInviteModel: Model<OrgInvite> =
  (mongoose.models.OrgInvite as Model<OrgInvite> | undefined) ?? mongoose.model<OrgInvite>("OrgInvite", orgInviteSchema);


