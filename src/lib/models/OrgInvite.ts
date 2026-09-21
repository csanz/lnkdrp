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

// Performance: listing invites in the Teams tab, and counting them for its filter tabs:
// OrgInvite.find({ orgId, isRevoked: false }).sort({ createdDate: -1 }).skip(...).limit(...)
//
// This filter used to read `{ isRevoked: { $ne: true } }`. MongoDB does not accept $ne in a partial
// filter (only equality, $exists:true, the range operators, $type, $and/$or/$in), so createIndex
// rejected it and *this index has never existed on any database* — the listing has always been an
// orgId scan with an in-memory sort, and the comment above it described an index nobody had.
// Equality is legal, and `isRevoked` has carried `default: false` since this model was first
// written, so every document has the field and `{ isRevoked: false }` selects exactly the same rows
// that `$ne: true` did.
//
// The queries in /api/org-invites were changed to `isRevoked: false` to match: the planner only uses
// a partial index when the query predicate provably implies the filter, and `$ne: true` does not
// (it would also match a document with no `isRevoked` field at all). Queries elsewhere that still
// say `$ne: true` are simply not served by this index.
//
// Migration note: since the broken index never built, there is nothing to drop on an existing
// database — but nothing will create the corrected one either until autoIndex runs again, so a
// deployment with autoIndex disabled needs a manual createIndex/reindex to actually get it.
orgInviteSchema.index(
  { orgId: 1, createdDate: -1 },
  { partialFilterExpression: { isRevoked: false } },
);

export type OrgInvite = InferSchemaType<typeof orgInviteSchema>;

export const OrgInviteModel: Model<OrgInvite> =
  (mongoose.models.OrgInvite as Model<OrgInvite> | undefined) ?? mongoose.model<OrgInvite>("OrgInvite", orgInviteSchema);


