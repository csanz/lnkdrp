/**
 * OAuth 2.1 for the MCP server: the app is the authorization server, a grant is a key by another
 * name.
 *
 * The flow a client walks (Claude Code, Cursor, Codex, a hosted connector):
 *
 * 1. `GET mcp.lnkdrp.com/.well-known/oauth-protected-resource` names this app as the
 *    authorization server; `GET /.well-known/oauth-authorization-server` here lists the endpoints.
 * 2. `POST /api/oauth/register` (RFC 7591): the client registers its name and redirect URI and
 *    gets a `client_id`. Nobody pre-creates clients; hosted connectors could not.
 * 3. `GET /connect/authorize`: the person signs in if needed, picks a workspace, clicks Allow.
 *    The app redirects back with a one-use code bound to the client's PKCE challenge.
 * 4. `POST /api/oauth/token`: code + verifier → access token (1 h) + refresh token (30 d), and an
 *    `OAuthGrant` row that is the credential's identity. Refresh rotates both tokens; the grant
 *    id stays, which is what the MCP server binds a session to.
 * 5. Every request then carries `Authorization: Bearer lnko_…`, and `verifyBearer`
 *    (`src/lib/gating/apiKeyActor.ts`) resolves it to the same `Actor` an `lnk_` key resolves to.
 *
 * Nothing here is a JWT. Tokens are random, stored hashed, and looked up like keys, so revoking
 * a grant stops it on the next request and the Connect page's Revoke button means what it says.
 *
 * Pure helpers (`isValidRedirectUri`, `pkceMatches`, `parseClientRegistration`,
 * `authorizationServerMetadata`, the token shapes) have no Mongo dependency and are tested in
 * `tests/lib/oauth.test.ts`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { newSecretToken } from "@/lib/crypto/randomBase62";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/models/ApiKey";
import { OAuthClientModel, OAUTH_CLIENT_AUTH_METHODS, type OAuthClientAuthMethod } from "@/lib/models/OAuthClient";
import { OAuthCodeModel } from "@/lib/models/OAuthCode";
import { OAuthGrantModel } from "@/lib/models/OAuthGrant";
import { resolveOwners, type KeyOwner } from "@/lib/agents/owners";
import type { AgentKeyRow } from "@/lib/client/useAgentStatus";
import { debugLog } from "@/lib/debug";

/** Access tokens: `lnko_` + 40 base62 chars. The prefix is how `verifyBearer` tells them from keys. */
export const OAUTH_ACCESS_PREFIX = "lnko_";
/** Refresh tokens: `lnkr_` + 48 base62 chars. Never accepted as a bearer. */
export const OAUTH_REFRESH_PREFIX = "lnkr_";
export const OAUTH_CLIENT_ID_PREFIX = "oac_";
const ACCESS_SECRET_LENGTH = 40;
const REFRESH_SECRET_LENGTH = 48;
const CLIENT_ID_SECRET_LENGTH = 24;
const CLIENT_SECRET_LENGTH = 48;
const CODE_SECRET_LENGTH = 40;

export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Registrations one address may make per hour. DCR is open by design; this bounds the damage. */
export const OAUTH_REGISTER_LIMIT_PER_HOUR = 20;
export const OAUTH_CLIENT_NAME_MAX_LENGTH = 80;
export const OAUTH_MAX_REDIRECT_URIS = 10;
/** Rows `listGrants` returns; the same cap as the key list it is merged into. */
const GRANT_LIST_LIMIT = 50;

const ACCESS_RE = new RegExp(`^${OAUTH_ACCESS_PREFIX}[0-9A-Za-z]{${ACCESS_SECRET_LENGTH}}$`);
const REFRESH_RE = new RegExp(`^${OAUTH_REFRESH_PREFIX}[0-9A-Za-z]{${REFRESH_SECRET_LENGTH}}$`);
const CLIENT_ID_RE = new RegExp(`^${OAUTH_CLIENT_ID_PREFIX}[0-9A-Za-z]{${CLIENT_ID_SECRET_LENGTH}}$`);
/** RFC 7636 §4.1: 43..128 chars of `[A-Za-z0-9-._~]`. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url without padding, as a client must send `code_challenge`. */
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

/** sha256 hex; what is stored for every token, code and secret. */
export function hashOAuthToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function looksLikeOAuthAccessToken(token: unknown): token is string {
  return typeof token === "string" && ACCESS_RE.test(token);
}

export function looksLikeOAuthRefreshToken(token: unknown): token is string {
  return typeof token === "string" && REFRESH_RE.test(token);
}

export function looksLikeOAuthClientId(id: unknown): id is string {
  return typeof id === "string" && CLIENT_ID_RE.test(id);
}

/**
 * Whether a registered redirect URI is one we will ever send a code to.
 *
 * OAuth 2.1 for native apps: `https` anywhere; `http` only on the loopback, where an installed
 * client such as Claude Code listens for the callback; and private-use schemes (`cursor://`,
 * `vscode://`), which the OS hands to the app that owns them. No fragment, ever. `javascript:`,
 * `data:` and `file:` are refused by name because a URL parser accepts them.
 */
export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https") return url.hostname.length > 0;
  if (scheme === "http") {
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  if (scheme === "javascript" || scheme === "data" || scheme === "file" || scheme === "blob" || scheme === "about") return false;
  // A private-use scheme must look like one: letters, digits, `+`, `-`, `.`; `web+x` is fine.
  return /^[a-z][a-z0-9+.-]+$/.test(scheme);
}

/**
 * Loopback redirects are matched on everything but the port (RFC 8252 §7.3): a CLI picks a free
 * port at each run and cannot register it ahead of time. Everything else is an exact match.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || b.protocol !== "http:") return false;
  const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  if (!loopback(a.hostname) || !loopback(b.hostname)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** RFC 7636 S256: `BASE64URL(SHA256(verifier)) === challenge`, compared in constant time. */
export function pkceMatches(codeVerifier: unknown, codeChallenge: string): boolean {
  if (typeof codeVerifier !== "string" || !VERIFIER_RE.test(codeVerifier)) return false;
  const computed = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(codeChallenge, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

/**
 * The `scope` parameter as scopes. Absent or empty means everything, as a key without an explicit
 * scope list does. Unknown scopes are an error rather than ignored, so a client that asks for
 * something we do not have finds out at authorize time, not on its first refused call.
 */
export function scopesFromParam(raw: unknown): ApiKeyScope[] | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return [...API_KEY_SCOPES];
  if (typeof raw !== "string") return null;
  const parts = raw.split(/[\s+]+/).filter(Boolean);
  const out: ApiKeyScope[] = [];
  for (const p of parts) {
    if (!(API_KEY_SCOPES as readonly string[]).includes(p)) return null;
    if (!out.includes(p as ApiKeyScope)) out.push(p as ApiKeyScope);
  }
  return out.length ? out : [...API_KEY_SCOPES];
}

/** RFC 8414 authorization server metadata for this deployment. */
export function authorizationServerMetadata(siteBase: string): Record<string, unknown> {
  const base = siteBase.replace(/\/+$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/connect/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
    scopes_supported: [...API_KEY_SCOPES],
    service_documentation: `${base}/connect`,
  };
}

export type ClientRegistration = {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  clientUri: string | null;
};

/**
 * Validate an RFC 7591 registration body. Returns the fields we keep, or the RFC error code and
 * a sentence for the `error_description`.
 */
export function parseClientRegistration(body: unknown): { ok: true; value: ClientRegistration } | { ok: false; error: "invalid_client_metadata" | "invalid_redirect_uri"; description: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: "invalid_client_metadata", description: "The body must be a JSON object." };

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must be a non-empty array." };
  if (uris.length > OAUTH_MAX_REDIRECT_URIS) return { ok: false, error: "invalid_redirect_uri", description: `At most ${OAUTH_MAX_REDIRECT_URIS} redirect_uris.` };
  const redirectUris: string[] = [];
  for (const u of uris) {
    if (!isValidRedirectUri(u)) return { ok: false, error: "invalid_redirect_uri", description: `Not an acceptable redirect URI: ${typeof u === "string" ? u.slice(0, 200) : typeof u}. Use https, http on localhost, or a private-use scheme.` };
    if (!redirectUris.includes(u)) redirectUris.push(u);
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const clientName = (rawName || "MCP client").slice(0, OAUTH_CLIENT_NAME_MAX_LENGTH);

  const method = b.token_endpoint_auth_method === undefined ? "none" : b.token_endpoint_auth_method;
  if (typeof method !== "string" || !(OAUTH_CLIENT_AUTH_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: "invalid_client_metadata", description: `token_endpoint_auth_method must be one of ${OAUTH_CLIENT_AUTH_METHODS.join(", ")}.` };
  }

  if (b.grant_types !== undefined) {
    if (!Array.isArray(b.grant_types) || b.grant_types.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return { ok: false, error: "invalid_client_metadata", description: "grant_types may only contain authorization_code and refresh_token." };
    }
  }
  if (b.response_types !== undefined) {
    if (!Array.isArray(b.response_types) || b.response_types.some((r) => r !== "code")) {
      return { ok: false, error: "invalid_client_metadata", description: "response_types may only contain code." };
    }
  }

  let clientUri: string | null = null;
  if (typeof b.client_uri === "string" && b.client_uri.trim()) {
    try {
      const u = new URL(b.client_uri.trim());
      if (u.protocol === "https:" || u.protocol === "http:") clientUri = u.toString().slice(0, 500);
    } catch {
      // A bad homepage is not a reason to refuse the client.
    }
  }

  return { ok: true, value: { clientName, redirectUris, tokenEndpointAuthMethod: method as OAuthClientAuthMethod, clientUri } };
}

// ---------------------------------------------------------------------------------------------
// Clients

export type RegisteredClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  clientUri: string | null;
  createdAt: Date;
};

/** Register a client. The secret, when the client asked for one, is returned exactly once. */
export async function registerClient(input: ClientRegistration & { ip: string | null }): Promise<{ client: RegisteredClient; clientSecret: string | null }> {
  const clientId = `${OAUTH_CLIENT_ID_PREFIX}${newSecretToken(CLIENT_ID_SECRET_LENGTH)}`;
  const clientSecret = input.tokenEndpointAuthMethod === "none" ? null : newSecretToken(CLIENT_SECRET_LENGTH);
  await connectMongo();
  const doc = await OAuthClientModel.create({
    clientId,
    clientSecretHash: clientSecret ? hashOAuthToken(clientSecret) : null,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    clientUri: input.clientUri,
    registeredFromIp: input.ip,
  });
  return { client: toRegisteredClient(doc), clientSecret };
}

function toRegisteredClient(doc: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  clientUri?: string | null;
  createdDate?: Date;
}): RegisteredClient {
  return {
    clientId: doc.clientId,
    clientName: doc.clientName,
    redirectUris: [...doc.redirectUris],
    tokenEndpointAuthMethod: doc.tokenEndpointAuthMethod as OAuthClientAuthMethod,
    clientUri: doc.clientUri ?? null,
    createdAt: doc.createdDate ?? new Date(0),
  };
}

export async function findClient(clientId: unknown): Promise<RegisteredClient | null> {
  if (!looksLikeOAuthClientId(clientId)) return null;
  await connectMongo();
  const doc = await OAuthClientModel.findOne({ clientId }).lean();
  return doc ? toRegisteredClient(doc) : null;
}

/**
 * Whether `presentedSecret` proves the client. A public client presents nothing and is accepted;
 * PKCE is its proof. A confidential client must present its secret.
 */
export async function authenticateClient(clientId: unknown, presentedSecret: string | null): Promise<RegisteredClient | null> {
  if (!looksLikeOAuthClientId(clientId)) return null;
  await connectMongo();
  const doc = await OAuthClientModel.findOne({ clientId }).lean();
  if (!doc) return null;
  if (doc.tokenEndpointAuthMethod === "none") return toRegisteredClient(doc);
  if (!presentedSecret || !doc.clientSecretHash) return null;
  const a = Buffer.from(hashOAuthToken(presentedSecret), "utf8");
  const b = Buffer.from(doc.clientSecretHash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return toRegisteredClient(doc);
}

// ---------------------------------------------------------------------------------------------
// Authorization codes

export type CreateCodeInput = {
  clientId: string;
  userId: string | Types.ObjectId;
  orgId: string | Types.ObjectId;
  scopes: ApiKeyScope[];
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
};

/** Mint a one-use code for the consent the person just gave. Returns the plaintext once. */
export async function createAuthorizationCode(input: CreateCodeInput): Promise<string> {
  const code = newSecretToken(CODE_SECRET_LENGTH);
  await connectMongo();
  await OAuthCodeModel.create({
    codeHash: hashOAuthToken(code),
    clientId: input.clientId,
    userId: toObjectId(input.userId),
    orgId: toObjectId(input.orgId),
    scopes: input.scopes,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS),
    usedAt: null,
    grantId: null,
  });
  return code;
}

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: ApiKeyScope[];
  grantId: string;
};

export type TokenFailure = { ok: false; error: "invalid_grant" | "invalid_request"; description: string };

/**
 * Exchange a code for tokens (RFC 6749 §4.1.3 with PKCE). Every check is here, in order: the
 * code exists and is this client's, unspent, unexpired, the redirect URI is the one consent was
 * given for, and the verifier matches the challenge.
 *
 * A code presented twice is treated as leaked: the grant it produced is revoked, so an attacker
 * who caught the redirect and an honest client racing for the same code both end up with nothing.
 */
export async function spendAuthorizationCode(input: { code: unknown; clientId: string; codeVerifier: unknown; redirectUri: unknown; clientName: string }): Promise<{ ok: true; tokens: IssuedTokens } | TokenFailure> {
  if (typeof input.code !== "string" || !input.code || input.code.length > 200) return { ok: false, error: "invalid_grant", description: "The authorization code is missing or malformed." };
  await connectMongo();
  const now = new Date();
  const doc = await OAuthCodeModel.findOne({ codeHash: hashOAuthToken(input.code) });
  if (!doc || doc.clientId !== input.clientId) return { ok: false, error: "invalid_grant", description: "Unknown authorization code." };
  if (doc.usedAt) {
    if (doc.grantId) {
      await OAuthGrantModel.updateOne({ _id: doc.grantId, revokedAt: null }, { $set: { revokedAt: now } });
      debugLog(1, "[agents/oauth] replayed code; grant revoked", { grantId: String(doc.grantId), clientId: input.clientId });
    }
    return { ok: false, error: "invalid_grant", description: "This authorization code was already used." };
  }
  if (doc.expiresAt.getTime() < now.getTime()) return { ok: false, error: "invalid_grant", description: "This authorization code has expired. Start the connection again." };
  if (typeof input.redirectUri !== "string" || input.redirectUri !== doc.redirectUri) return { ok: false, error: "invalid_grant", description: "redirect_uri does not match the authorization request." };
  if (!pkceMatches(input.codeVerifier, doc.codeChallenge)) return { ok: false, error: "invalid_grant", description: "PKCE verification failed." };

  // Mark the code spent before minting, so two concurrent exchanges cannot both succeed.
  const claimed = await OAuthCodeModel.findOneAndUpdate({ _id: doc._id, usedAt: null }, { $set: { usedAt: now } }, { new: true }).lean();
  if (!claimed) return { ok: false, error: "invalid_grant", description: "This authorization code was already used." };

  const accessToken = `${OAUTH_ACCESS_PREFIX}${newSecretToken(ACCESS_SECRET_LENGTH)}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${newSecretToken(REFRESH_SECRET_LENGTH)}`;
  const scopes = (doc.scopes ?? []).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));
  const grant = await OAuthGrantModel.create({
    orgId: doc.orgId,
    createdByUserId: doc.userId,
    clientId: input.clientId,
    clientName: input.clientName.slice(0, OAUTH_CLIENT_NAME_MAX_LENGTH),
    scopes,
    accessTokenHash: hashOAuthToken(accessToken),
    accessExpiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_MS),
    refreshTokenHash: hashOAuthToken(refreshToken),
    refreshExpiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_MS),
    lastUsedAt: null,
    lastUsedClient: null,
    useCount: 0,
    revokedAt: null,
    isDeleted: false,
  });
  await OAuthCodeModel.updateOne({ _id: doc._id }, { $set: { grantId: grant._id } });
  return { ok: true, tokens: { accessToken, refreshToken, expiresIn: Math.floor(OAUTH_ACCESS_TTL_MS / 1000), scopes, grantId: String(grant._id) } };
}

/**
 * Rotate a grant's tokens (RFC 6749 §6). The old refresh token stops working at once; the grant
 * id, and with it the MCP session bound to it, survives.
 */
export async function refreshGrant(input: { refreshToken: unknown; clientId: string }): Promise<{ ok: true; tokens: IssuedTokens } | TokenFailure> {
  if (!looksLikeOAuthRefreshToken(input.refreshToken)) return { ok: false, error: "invalid_grant", description: "The refresh token is missing or malformed." };
  await connectMongo();
  const now = new Date();
  const accessToken = `${OAUTH_ACCESS_PREFIX}${newSecretToken(ACCESS_SECRET_LENGTH)}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${newSecretToken(REFRESH_SECRET_LENGTH)}`;
  // One atomic swap: whoever presents the current refresh token first wins; a second presenter
  // finds no row and is refused, which is the rotation guarantee.
  const doc = await OAuthGrantModel.findOneAndUpdate(
    {
      refreshTokenHash: hashOAuthToken(input.refreshToken),
      clientId: input.clientId,
      revokedAt: null,
      isDeleted: { $ne: true },
      refreshExpiresAt: { $gt: now },
    },
    {
      $set: {
        accessTokenHash: hashOAuthToken(accessToken),
        accessExpiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_MS),
        refreshTokenHash: hashOAuthToken(refreshToken),
        refreshExpiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_MS),
      },
    },
    { new: true },
  )
    .select({ scopes: 1 })
    .lean();
  if (!doc) return { ok: false, error: "invalid_grant", description: "The refresh token is unknown, expired or revoked. Connect again." };
  const scopes = (doc.scopes ?? []).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));
  return { ok: true, tokens: { accessToken, refreshToken, expiresIn: Math.floor(OAUTH_ACCESS_TTL_MS / 1000), scopes, grantId: String(doc._id) } };
}

// ---------------------------------------------------------------------------------------------
// Bearer verification and management

export type VerifiedGrant = {
  id: string;
  orgId: string;
  userId: string;
  clientName: string;
  scopes: ApiKeyScope[];
  useCount: number;
  lastUsedClient: string | null;
};

export type VerifyGrantResult = { ok: true; grant: VerifiedGrant } | { ok: false; code: "unauthorized" | "key_revoked" | "token_expired" };

/** Resolve an `lnko_` access token to its grant. Expired is its own answer: the client should refresh, not re-consent. */
export async function verifyAccessToken(token: unknown): Promise<VerifyGrantResult> {
  if (!looksLikeOAuthAccessToken(token)) return { ok: false, code: "unauthorized" };
  await connectMongo();
  const doc = await OAuthGrantModel.findOne({ accessTokenHash: hashOAuthToken(token), isDeleted: { $ne: true } })
    .select({ orgId: 1, createdByUserId: 1, clientName: 1, scopes: 1, revokedAt: 1, accessExpiresAt: 1, useCount: 1, lastUsedClient: 1 })
    .lean();
  if (!doc) return { ok: false, code: "unauthorized" };
  if (doc.revokedAt) return { ok: false, code: "key_revoked" };
  if (doc.accessExpiresAt.getTime() < Date.now()) return { ok: false, code: "token_expired" };
  return {
    ok: true,
    grant: {
      id: String(doc._id),
      orgId: String(doc.orgId),
      userId: String(doc.createdByUserId),
      clientName: doc.clientName,
      scopes: (doc.scopes ?? []).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)),
      useCount: typeof doc.useCount === "number" ? doc.useCount : 0,
      lastUsedClient: typeof doc.lastUsedClient === "string" ? doc.lastUsedClient : null,
    },
  };
}

/** RFC 7009: revoke by either token. Unknown tokens are a no-op, as the RFC requires. */
export async function revokeGrantByToken(input: { token: unknown; clientId: string }): Promise<boolean> {
  if (typeof input.token !== "string") return false;
  const filter = looksLikeOAuthAccessToken(input.token)
    ? { accessTokenHash: hashOAuthToken(input.token) }
    : looksLikeOAuthRefreshToken(input.token)
      ? { refreshTokenHash: hashOAuthToken(input.token) }
      : null;
  if (!filter) return false;
  await connectMongo();
  const res = await OAuthGrantModel.updateOne({ ...filter, clientId: input.clientId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return res.modifiedCount > 0;
}

/** Revoke a grant from the Connect page. Same contract as `revokeApiKey`: null when not this workspace's, or already revoked. */
export async function revokeGrant(input: { orgId: string | Types.ObjectId; grantId: string }): Promise<AgentKeyRow | null> {
  if (!Types.ObjectId.isValid(input.grantId)) return null;
  await connectMongo();
  const doc = await OAuthGrantModel.findOneAndUpdate(
    { _id: new Types.ObjectId(input.grantId), orgId: toObjectId(input.orgId), revokedAt: null, isDeleted: { $ne: true } },
    { $set: { revokedAt: new Date() } },
    { new: true },
  ).lean();
  if (!doc) return null;
  const owners = await resolveOwners([doc.createdByUserId]);
  return toGrantRow(doc, owners.get(String(doc.createdByUserId)) ?? null);
}

type GrantRowSource = {
  _id: Types.ObjectId | string;
  clientName: string;
  scopes?: readonly string[] | null;
  createdDate?: Date | null;
  lastUsedAt?: Date | null;
  lastUsedClient?: string | null;
  revokedAt?: Date | null;
  createdByUserId?: Types.ObjectId | string | null;
};

/** A grant in the Connect page's row shape. `prefix` is the word the UI shows where a key shows its first chars. */
export function toGrantRow(doc: GrantRowSource, owner: KeyOwner | null): AgentKeyRow {
  const iso = (v: Date | null | undefined) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null);
  return {
    id: String(doc._id),
    name: doc.clientName,
    prefix: "signed in",
    scopes: (doc.scopes ?? []).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)),
    createdAt: iso(doc.createdDate) ?? new Date(0).toISOString(),
    lastUsedAt: iso(doc.lastUsedAt),
    lastUsedClient: doc.lastUsedClient ?? null,
    revoked: Boolean(doc.revokedAt),
    createdBy: owner,
    kind: "oauth",
  };
}

const GRANT_ROW_SELECT = { clientName: 1, scopes: 1, createdDate: 1, lastUsedAt: 1, lastUsedClient: 1, revokedAt: 1, createdByUserId: 1 } as const;

/** Grants for a workspace, newest first, revoked included. */
export async function listGrants(orgId: string | Types.ObjectId): Promise<AgentKeyRow[]> {
  await connectMongo();
  const docs = await OAuthGrantModel.find({ orgId: toObjectId(orgId), isDeleted: { $ne: true } })
    .sort({ createdDate: -1 })
    .limit(GRANT_LIST_LIMIT)
    .select(GRANT_ROW_SELECT)
    .lean();
  const owners = await resolveOwners(docs.map((d) => d.createdByUserId ?? null));
  return docs.map((d) => toGrantRow(d, d.createdByUserId ? (owners.get(String(d.createdByUserId)) ?? null) : null));
}

/** Active grants used at least once, most recently used first; feeds the "connected" status. */
export async function listUsedActiveGrants(orgId: string | Types.ObjectId): Promise<AgentKeyRow[]> {
  await connectMongo();
  const docs = await OAuthGrantModel.find({ orgId: toObjectId(orgId), isDeleted: { $ne: true }, revokedAt: null, lastUsedAt: { $ne: null } })
    .sort({ lastUsedAt: -1 })
    .limit(GRANT_LIST_LIMIT)
    .select(GRANT_ROW_SELECT)
    .lean();
  const owners = await resolveOwners(docs.map((d) => d.createdByUserId ?? null));
  return docs.map((d) => toGrantRow(d, d.createdByUserId ? (owners.get(String(d.createdByUserId)) ?? null) : null));
}

const touchedAt = new Map<string, number>();
const TOUCH_MAP_MAX = 1000;
const TOUCH_THROTTLE_MS = 1_000;

/** Record a use of a grant, throttled per (grant, client) like `touchApiKeyUse`. Never throws. */
export async function touchGrantUse(input: { grantId: string; client: string | null }): Promise<void> {
  try {
    const now = Date.now();
    const throttleKey = `${input.grantId}|${input.client ?? ""}`;
    const last = touchedAt.get(throttleKey);
    if (typeof last === "number" && now - last < TOUCH_THROTTLE_MS) return;
    touchedAt.set(throttleKey, now);
    if (touchedAt.size > TOUCH_MAP_MAX) {
      const oldest = touchedAt.keys().next().value;
      if (oldest) touchedAt.delete(oldest);
    }
    if (!Types.ObjectId.isValid(input.grantId)) return;
    await connectMongo();
    await OAuthGrantModel.updateOne({ _id: new Types.ObjectId(input.grantId) }, { $set: { lastUsedAt: new Date(now), lastUsedClient: input.client ?? null }, $inc: { useCount: 1 } });
  } catch (err) {
    debugLog(1, "[agents/oauth] touchGrantUse failed", { grantId: input.grantId, message: err instanceof Error ? err.message : "Unknown error" });
  }
}

function toObjectId(v: string | Types.ObjectId): Types.ObjectId {
  return v instanceof Types.ObjectId ? v : new Types.ObjectId(String(v));
}
