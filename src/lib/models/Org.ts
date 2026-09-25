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
import { DEFAULT_WORKSPACE_NAME } from "@/lib/orgs/defaultName";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";

const orgSchema = new Schema(
  {
    type: { type: String, trim: true, required: true, enum: ["personal", "team"], index: true },
    /** For personal orgs only: points back to the owning user (unique, sparse). */
    // No default: a team org must leave this field MISSING, not null. The unique index below is
    // partial, and an explicit null would make every team org collide with the previous one.
    personalForUserId: { type: Schema.Types.ObjectId, ref: "User" },
    name: { type: String, trim: true, required: true },
    /**
     * Optional org avatar/icon URL (e.g. a GSuite/Workspace logo or a custom upload).
     *
     * Note: Google OAuth profile does not provide a workspace logo by default; wiring that
     * would require additional Google Admin/Directory APIs. For now this is user-provided
     * (or null to render an initials avatar).
     */
    avatarUrl: { type: String, trim: true, default: null },
    /**
     * For team orgs only: public-ish identifier used for deep links later.
     *
     * Personal orgs omit this field entirely (no `null` default) so the partial unique index
     * below only ever sees string values. An explicit `null` would be indexed and collide.
     */
    slug: { type: String, trim: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * One-time join secret (short-lived) used for "create org → re-auth → join as another user".
     *
     * This is stored as a hash (never store plaintext secrets). When present and unexpired, a user
     * presenting the secret (via httpOnly cookie) can be auto-joined to the org.
     */
    joinSecretHash: { type: String, default: null },
    joinSecretExpiresAt: { type: Date, default: null, index: true },

    /**
     * Plan-limit grace window (see `src/lib/billing/planLimits.ts`).
     *
     * Set when a Free workspace is found over a Free limit (grandfathered or downgraded from Pro);
     * the workspace keeps working until `endsAt`, after which the grace cron sets `blockedAt`.
     * `remindersSent` records when reminder emails went out. `null` when no grace window applies.
     */
    planGrace: {
      type: new Schema(
        {
          startedAt: { type: Date, required: true },
          endsAt: { type: Date, required: true },
          blockedAt: { type: Date, default: null },
          remindersSent: { type: [Date], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },

    /**
     * Rotation marker for the plan-limit grace sweep (`src/lib/billing/planGrace.ts`).
     *
     * The sweep is budgeted (`?limit=`, 500 per hourly run) and stamps every workspace it looked
     * at, so the next run can take the least recently scanned ones first. Missing/null sorts first
     * ascending, which is what we want: a workspace nobody has ever scanned goes to the front.
     * Only the sweep writes it, and it is not part of any workspace's user-facing state.
     */
    planLimitsScannedAt: { type: Date, default: null, index: true },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One personal org per user. Partial (not `sparse`) for the same reason as `slug` below: `sparse`
// still indexes an explicit null, so two team orgs written with `personalForUserId: null` collided.
orgSchema.index(
  { personalForUserId: 1 },
  { unique: true, partialFilterExpression: { personalForUserId: { $type: "objectId" } } },
);
// Team org slugs are unique. Personal orgs omit `slug`; the partial filter (rather than `sparse`)
// guarantees only string slugs participate, since `sparse` still indexes an explicit `null`.
orgSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });


export type Org = InferSchemaType<typeof orgSchema>;

export const OrgModel: Model<Org> =
  (mongoose.models.Org as Model<Org> | undefined) ?? mongoose.model<Org>("Org", orgSchema);

// Dev safety: patch in new fields during hot reload (mongoose model caching).
const ExistingOrgModel = mongoose.models.Org as Model<Org> | undefined;
if (ExistingOrgModel && !ExistingOrgModel.schema.path("planGrace")) {
  ExistingOrgModel.schema.add({
    planGrace: { type: orgSchema.path("planGrace").schema, default: null },
  } as any);
}
if (ExistingOrgModel && !ExistingOrgModel.schema.path("planLimitsScannedAt")) {
  ExistingOrgModel.schema.add({ planLimitsScannedAt: { type: Date, default: null } } as any);
}

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
  const name = (opts.name ?? DEFAULT_WORKSPACE_NAME).trim() || DEFAULT_WORKSPACE_NAME;

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
    // Intentionally no `slug`: personal orgs must not participate in the partial unique slug index.
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


