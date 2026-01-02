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
    tempSecretHash: { type: String, default: null },

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
    role: { type: String, default: "user", trim: true, index: true },

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






