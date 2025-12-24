import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * `invites` collection
 *
 * - "invite": a usable invite code
 * - "request": a user's request for a code (email + description)
 */
const inviteSchema = new Schema(
  {
    kind: { type: String, enum: ["invite", "request"], required: true, index: true },

    // For kind === "invite"
    code: { type: String, trim: true, default: null, index: true, unique: true, sparse: true },
    isActive: { type: Boolean, default: true, index: true },

    // For kind === "request"
    requestEmail: { type: String, trim: true, lowercase: true, default: null, index: true },
    requestDescription: { type: String, trim: true, default: null },

    // Approval tracking (for kind === "request")
    approvedDate: { type: Date, default: null, index: true },
    approvedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    approvedInviteId: { type: Schema.Types.ObjectId, ref: "Invite", default: null, index: true },
    approvedInviteCode: { type: String, trim: true, default: null },
    approvalEmailSentDate: { type: Date, default: null },
    approvalEmailError: { type: String, trim: true, default: null },
  },
  { timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" }, minimize: false },
);

export type Invite = InferSchemaType<typeof inviteSchema>;

export const InviteModel: Model<Invite> = (() => {
  const existing = mongoose.models.Invite as Model<Invite> | undefined;
  if (existing) return existing;
  return mongoose.model<Invite>("Invite", inviteSchema);
})();


