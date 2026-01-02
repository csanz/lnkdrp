/**
 * Organization model.
 *
 * Orgs are the tenancy boundary for user-owned records (projects, docs, uploads, etc).
 *
 * Notes:
 * - Every user has a 1:1 "personal" org (`personalForUserId`).
 * - Additional orgs are "team" orgs (multi-member) and are addressed by a unique `slug`.
 */
import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";

const orgSchema = new Schema(
  {
    type: { type: String, trim: true, required: true, enum: ["personal", "team"], index: true },
    /** For personal orgs only: points back to the owning user (unique, sparse). */
    personalForUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, trim: true, required: true },
    /**
     * Optional org avatar/icon URL (e.g. a GSuite/Workspace logo or a custom upload).
     *
     * Note: Google OAuth profile does not provide a workspace logo by default; wiring that
     * would require additional Google Admin/Directory APIs. For now this is user-provided
     * (or null to render an initials avatar).
     */
    avatarUrl: { type: String, trim: true, default: null },
    /** For team orgs only: public-ish identifier used for deep links later (unique, sparse). */
    slug: { type: String, trim: true, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * One-time join secret (short-lived) used for "create org → re-auth → join as another user".
     *
     * This is stored as a hash (never store plaintext secrets). When present and unexpired, a user
     * presenting the secret (via httpOnly cookie) can be auto-joined to the org.
     */
    joinSecretHash: { type: String, default: null },
    joinSecretExpiresAt: { type: Date, default: null, index: true },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One personal org per user.
orgSchema.index({ personalForUserId: 1 }, { unique: true, sparse: true });
// Team org slugs are unique (personal orgs keep slug null).
orgSchema.index({ slug: 1 }, { unique: true, sparse: true });

export type Org = InferSchemaType<typeof orgSchema>;

export const OrgModel: Model<Org> =
  (mongoose.models.Org as Model<Org> | undefined) ?? mongoose.model<Org>("Org", orgSchema);

/**
 * Ensure a user has a personal org and membership.
 *
 * This is safe to call repeatedly (idempotent) and is used to bootstrap org state
 * for existing users and for temp users created during unauthenticated flows.
 */
export async function ensurePersonalOrgForUserId(opts: {
  userId: Types.ObjectId;
  /**
   * Optional display name used for new personal orgs.
   * If omitted, defaults to "Personal".
   */
  name?: string;
}): Promise<{ orgId: Types.ObjectId }> {
  const { userId } = opts;
  const name = (opts.name ?? "Personal").trim() || "Personal";

  // 1) Find existing personal org.
  const existing = await OrgModel.findOne({
    type: "personal",
    personalForUserId: userId,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean();
  if (existing?._id) {
    // Ensure membership exists (best-effort; ignore dupes).
    try {
      await OrgMembershipModel.updateOne(
        { orgId: existing._id, userId },
        { $setOnInsert: { orgId: existing._id, userId, role: "owner", createdDate: new Date() } },
        { upsert: true },
      );
    } catch {
      // ignore; best-effort
    }
    return { orgId: existing._id };
  }

  // 2) Create org + membership.
  const now = new Date();
  const created = await OrgModel.create({
    type: "personal",
    personalForUserId: userId,
    name,
    slug: null,
    createdByUserId: userId,
    isDeleted: false,
    createdDate: now,
    updatedDate: now,
  });
  const org = (Array.isArray(created) ? created[0] : created) as typeof created;

  await OrgMembershipModel.create({
    orgId: (org as unknown as { _id: Types.ObjectId })._id,
    userId,
    role: "owner",
    createdDate: now,
    updatedDate: now,
  });

  return { orgId: (org as unknown as { _id: Types.ObjectId })._id };
}


