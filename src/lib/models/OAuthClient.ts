/**
 * OAuthClient model.
 *
 * An MCP client that registered itself through dynamic client registration (RFC 7591,
 * `POST /api/oauth/register`) so a person can connect it to a workspace by signing in rather
 * than by pasting a key. Claude Code, Cursor, Codex and hosted connectors all register this way,
 * each with the redirect URI it will listen on; the authorize step refuses any other.
 *
 * Most clients are public (`tokenEndpointAuthMethod: "none"`) and prove themselves with PKCE.
 * One that asks for a secret gets one, shown once at registration; only its sha256 is kept.
 *
 * Rows are never deleted: a grant (`OAuthGrant`) points at the client that holds it, and the
 * Connect page names that client next to the Revoke button.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const OAUTH_CLIENT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type OAuthClientAuthMethod = (typeof OAUTH_CLIENT_AUTH_METHODS)[number];

const oauthClientSchema = new Schema(
  {
    /** Public identifier handed to the client at registration (`oac_` + 24 base62 chars). */
    clientId: { type: String, required: true, unique: true, index: true },
    /** sha256 hex of the client secret, or null for a public client. */
    clientSecretHash: { type: String, default: null },
    /** What the client called itself; what the person sees on the consent screen. */
    clientName: { type: String, required: true, trim: true, maxlength: 80 },
    /** Exact-match allow-list for `redirect_uri`. */
    redirectUris: { type: [String], required: true },
    tokenEndpointAuthMethod: { type: String, enum: OAUTH_CLIENT_AUTH_METHODS, required: true },
    /** Optional homepage the client sent (`client_uri`); shown as a link on consent when present. */
    clientUri: { type: String, default: null, trim: true },
    /** Address the registration came from, for the per-address ceiling and for abuse triage. */
    registeredFromIp: { type: String, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

export type OAuthClient = InferSchemaType<typeof oauthClientSchema>;

export const OAuthClientModel: Model<OAuthClient> =
  (mongoose.models.OAuthClient as Model<OAuthClient> | undefined) ??
  mongoose.model<OAuthClient>("OAuthClient", oauthClientSchema, "oauthclients");
