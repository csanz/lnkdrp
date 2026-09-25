import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import crypto from "node:crypto";

// Canonical user schema for the app. This is intentionally explicit and stable:
// - Users are unique by email (Google OAuth email)
// - Auth provider is currently only "google"
// - providerAccountId is the Google "sub" (stable account identifier)
const userSchema = new Schema(
  {
    /**
     * Temp-user support
     *
     * When `isTemp=true`, the user:
     * - has no email/providerAccountId
     * - is identified by `_id` + a client-held secret (sent in headers)
     */
    isTemp: { type: Boolean, default: false, index: true },
    /**
     * `select: false`: a bearer hash that only `resolveActor` and `/api/auth/claim-temp` compare.
     * Every other read of a user row (admin lists, session lookups, support cards) gets it left
     * out unless it asks with `+tempSecretHash`, so safety no longer depends on each of those
     * projecting it away.
     */
    tempSecretHash: { type: String, default: null, select: false },

    email: {
      type: String,
      required: function requiredEmail() {
        // `this` is a mongoose document.
        return !(this as unknown as { isTemp?: unknown }).isTemp;
      },
      unique: true,
      sparse: true,
      index: true,
      lowercase: true,
      trim: true,
    },

    name: { type: String, trim: true },
    image: { type: String, trim: true },

    authProvider: {
      type: String,
      required: function requiredProvider() {
        return !(this as unknown as { isTemp?: unknown }).isTemp;
      },
      enum: ["google"],
      default: "google",
      index: true,
    },
    providerAccountId: {
      type: String,
      required: function requiredProviderAccountId() {
        return !(this as unknown as { isTemp?: unknown }).isTemp;
      },
      trim: true,
      index: true,
      sparse: true,
    },

    createdAt: { type: Date, required: true, default: () => new Date() },
    lastLoginAt: { type: Date, required: true, default: () => new Date() },

    isActive: { type: Boolean, default: true, index: true },

    /**
     * Account deletion, in two steps.
     *
     * Asking to delete sets `deletionRequestedAt` and `isActive: false` at once: the account stops
     * working immediately (sign-in refused, live sessions dropped at the next request) while the
     * data is still here. `deletionPurgeAfter` is when the purge job may remove it for real, 30 days
     * later, which leaves room to undo a mistake or answer a support question. `deletionPurgedAt` is
     * set by that job once the blobs and rows are gone.
     *
     * The reason is what the person chose from the list, plus anything they typed. Both are optional:
     * nobody has to explain themselves to leave.
     */
    deletionRequestedAt: { type: Date, default: null, index: true },
    deletionReasonCode: { type: String, trim: true, default: null },
    deletionReasonText: { type: String, trim: true, default: null },
    deletionPurgeAfter: { type: Date, default: null, index: true },
    deletionPurgedAt: { type: Date, default: null, index: true },
    role: { type: String, default: "user", trim: true, index: true },

    /**
     * Billing plan for this user.
     *
     * IMPORTANT: This is only flipped to "pro" by Stripe webhooks. We do NOT grant access
     * based on the Checkout success redirect.
     */
    plan: { type: String, enum: ["free", "pro"], default: "free", index: true },

    /**
     * Stripe identifiers (persisted so we can reconcile webhooks + open the billing portal).
     *
     * These are optional because most users will start as "free".
     */
    stripeCustomerId: { type: String, trim: true, default: null, index: true },
    stripeSubscriptionId: { type: String, trim: true, default: null, index: true },
    stripeSubscriptionStatus: { type: String, trim: true, default: null },
    stripeCurrentPeriodEnd: { type: Date, default: null },

    /**
     * Usage-based billing (cents).
     *
     * - spendLimitCents: hard spend limit for the current billing period (0 disables usage).
     * - spendUsedCentsThisPeriod: tracked usage spend for the current billing period.
     */
    spendLimitCents: { type: Number, default: 0, min: 0 },
    spendUsedCentsThisPeriod: { type: Number, default: 0, min: 0 },

    /**
     * Early-access queue.
     *
     * `approved` is the default on purpose: every account that existed before the queue did, and
     * every account created while `WAITLIST_ENABLED` is off, is simply let in. Only a brand-new
     * sign-up made while the queue is on starts as `waitlisted`, so turning the flag on never locks
     * out the people already using the product.
     *
     * `waitlistedAt` is what orders the queue (and what a person's "#41 in line" is counted from),
     * so it is set once at sign-up and never touched again.
     */
    accessStatus: { type: String, enum: ["approved", "waitlisted"], default: "approved", index: true },
    waitlistedAt: { type: Date, default: null, index: true },
    approvedAt: { type: Date, default: null },
    approvedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /**
     * When this person accepted the Terms and the Privacy Policy, and which version they saw.
     *
     * Written by `POST /api/waitlist/accept`, from the `/accept` page an invitation links to. It is
     * the *signed-in* account that is recorded, never merely whoever opened the email: invitation
     * mail is forwarded and archived, and "somebody with this link agreed" is not a record worth
     * keeping.
     *
     * `termsVersion` is stored rather than implied so a later change to the Terms can tell who has
     * seen which, instead of a date that has to be compared against a changelog nobody updated.
     * `null` means never accepted, which is every account that predates this field.
     */
    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null, trim: true },

    onboardingCompleted: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    // We explicitly manage createdAt/lastLoginAt for clarity and to avoid mixing
    // Mongoose timestamps with app-level semantics.
    timestamps: false,
    minimize: false,
  },
);

export type User = InferSchemaType<typeof userSchema>;

export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ??
  mongoose.model<User>("User", userSchema);

/**
 * Create a new temp user and return its client secret.
 *
 * Notes:
 * - The secret is only returned once (caller should store it in localStorage).
 * - We store a hash in Mongo so the raw secret is not persisted.
 */
export async function createTempUser() {
  const secret = crypto.randomBytes(24).toString("base64url");
  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  const now = new Date();

  const u = await UserModel.create({
    isTemp: true,
    tempSecretHash: secretHash,
    createdAt: now,
    lastLoginAt: now,
    isActive: true,
    role: "temp",
    onboardingCompleted: false,
    metadata: {},
  });

  // Ensure we return string id + secret only (minimal surface area).
  return { id: String(u._id), secret };
}

/**
 * Verify Temp User Secret.
 */
export function verifyTempUserSecret(params: { secret: string; secretHash: string | null }) {
  const { secret, secretHash } = params;
  if (!secretHash) return false;
  const computed = crypto.createHash("sha256").update(secret).digest("hex");
  // Constant-time compare to reduce timing side-channels.
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(secretHash));
  } catch {
    return false;
  }
}






