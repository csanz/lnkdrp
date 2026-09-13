/**
 * ApiKey model.
 *
 * Workspace-scoped bearer keys that AI agents / MCP clients use to authenticate as the workspace
 * (see `src/lib/agents/apiKeys.ts` for minting and `src/lib/gating/apiKeyActor.ts` for
 * verification). Plaintext keys look like `lnk_` + 32 base62 chars and are shown to the user
 * exactly once; only the sha256 `keyHash` is stored, plus a short display `prefix`.
 *
 * Keys are never hard-deleted from the UI: revoking sets `revokedAt` so the Connect page can still
 * list them (and `getAgentStatus()` can count a revoked-but-once-used key as "has connected").
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const apiKeySchema = new Schema(
  {
    /** Workspace the key authenticates as (tenancy boundary). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Member who minted the key; API requests are attributed to this user. */
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /** Human label chosen at creation, e.g. "Claude Code on my laptop". */
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** First 12 chars of the plaintext (`lnk_ab12cd34`), for display only. */
    prefix: { type: String, required: true, trim: true },
    /** sha256 hex of the full plaintext key. The plaintext is never stored. */
    keyHash: { type: String, required: true, unique: true, index: true },
    scopes: { type: [String], enum: API_KEY_SCOPES, default: () => [...API_KEY_SCOPES] },
    lastUsedAt: { type: Date, default: null },
    /** Client label on last use (e.g. "Claude Code"), derived from `x-lnkdrp-agent` / User-Agent. */
    lastUsedClient: { type: String, default: null, trim: true },
    useCount: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

apiKeySchema.index({ orgId: 1, createdDate: -1 });
apiKeySchema.index({ orgId: 1, revokedAt: 1, isDeleted: 1 });

export type ApiKey = InferSchemaType<typeof apiKeySchema>;

export const ApiKeyModel: Model<ApiKey> =
  (mongoose.models.ApiKey as Model<ApiKey> | undefined) ?? mongoose.model<ApiKey>("ApiKey", apiKeySchema, "apikeys");
