/**
 * OAuthCode model: one authorization code, from the consent screen to the token endpoint.
 *
 * Created when a signed-in member clicks Allow on `/connect/authorize`; spent once by
 * `POST /api/oauth/token`, which turns it into an `OAuthGrant`. It carries everything the token
 * endpoint must check against the exchange request: the client, the redirect URI, the PKCE
 * challenge and the resource the client asked for. Only the sha256 of the code is stored.
 *
 * Codes live for minutes. `usedAt` is set on exchange so a replayed code is refused; a second use
 * of a code is the classic sign that it leaked in a redirect, so the grant it produced is revoked
 * at the same time (`spendAuthorizationCode`).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { API_KEY_SCOPES } from "@/lib/models/ApiKey";

const oauthCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true },
    scopes: { type: [String], enum: API_KEY_SCOPES, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    /** The MCP server URL the client named (RFC 8707), or null when it named none. */
    resource: { type: String, default: null },
    // Indexed by the TTL declaration below; a second plain index here made Mongoose warn on every
    // build and every boot about the duplicate.
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    /** The grant this code became, so a replay can revoke it. */
    grantId: { type: Schema.Types.ObjectId, ref: "OAuthGrant", default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Spent and expired codes are worthless after a day; let Mongo sweep them.
oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type OAuthCode = InferSchemaType<typeof oauthCodeSchema>;

export const OAuthCodeModel: Model<OAuthCode> =
  (mongoose.models.OAuthCode as Model<OAuthCode> | undefined) ?? mongoose.model<OAuthCode>("OAuthCode", oauthCodeSchema, "oauthcodes");
