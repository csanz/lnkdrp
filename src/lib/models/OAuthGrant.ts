/**
 * OAuthGrant model: one agent, connected to one workspace by one person, through OAuth.
 *
 * The OAuth counterpart of `ApiKey`. Where a key is a static secret a person pastes into a
 * config, a grant is what a consent click produces: the same `{ orgId, createdByUserId, scopes }`
 * a key carries, so `verifyBearer` resolves either to the same `Actor` and every tool, gate and
 * activity row works unchanged (see `src/lib/gating/apiKeyActor.ts`).
 *
 * What differs is the credential. A grant holds a short-lived access token and a refresh token,
 * both stored as sha256 hashes; `refreshGrant` rotates both and keeps the grant id, which is what
 * the MCP server binds a session to, since the token itself changes every hour.
 *
 * Revoking sets `revokedAt` and the row stays listed on the Connect page, like a revoked key.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { API_KEY_SCOPES } from "@/lib/models/ApiKey";

const oauthGrantSchema = new Schema(
  {
    /** Workspace the grant acts in (tenancy boundary). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** The member who clicked Allow; the grant acts as them. */
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    clientId: { type: String, required: true, index: true },
    /** Denormalised from the client at grant time: what the Connect page shows as the name. */
    clientName: { type: String, required: true, trim: true, maxlength: 80 },
    scopes: { type: [String], enum: API_KEY_SCOPES, default: () => [...API_KEY_SCOPES] },

    accessTokenHash: { type: String, required: true, unique: true, index: true },
    accessExpiresAt: { type: Date, required: true },
    refreshTokenHash: { type: String, required: true, unique: true, index: true },
    refreshExpiresAt: { type: Date, required: true },

    lastUsedAt: { type: Date, default: null },
    /** Client label from `x-lnkdrp-agent` on last use, e.g. "Claude Code". */
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

oauthGrantSchema.index({ orgId: 1, createdDate: -1 });
oauthGrantSchema.index({ orgId: 1, revokedAt: 1, isDeleted: 1 });

export type OAuthGrant = InferSchemaType<typeof oauthGrantSchema>;

export const OAuthGrantModel: Model<OAuthGrant> =
  (mongoose.models.OAuthGrant as Model<OAuthGrant> | undefined) ??
  mongoose.model<OAuthGrant>("OAuthGrant", oauthGrantSchema, "oauthgrants");
