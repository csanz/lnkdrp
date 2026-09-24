/**
 * Bearer-token auth seam for agent / MCP clients.
 *
 * `verifyBearer(request)` reads `Authorization: Bearer <token>`. Two token shapes resolve here:
 *
 * - `lnk_…`: a workspace API key (`src/lib/agents/apiKeys.ts`), sha256-hashed and looked up by
 *   `keyHash`.
 * - `lnko_…`: an OAuth access token (`src/lib/agents/oauth.ts`), the credential an agent holds
 *   after a person connected it by signing in. Looked up the same way, on the grant.
 *
 * Either way the caller gets the same `Actor` (`kind: "user"`, attributed to the member who made
 * the credential, scoped to its workspace) and a `VerifiedApiKey` whose `id` is the key's or the
 * grant's. Every gate downstream is therefore indifferent to how the agent authenticated, which
 * is the point: a revoked grant fails the way a revoked key does, on the next request.
 * Any other token shape is `unauthorized`.
 *
 * The plaintext token is never logged. The MCP server calls `verifyBearer` on every request; the
 * web app uses it only on `GET /api/agent/whoami` (no session / temp-user fallback there).
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { ApiKeyModel, type ApiKeyScope } from "@/lib/models/ApiKey";
import { OrgModel } from "@/lib/models/Org";
import { API_KEY_PREFIX, hashApiKey, looksLikeApiKey, touchApiKeyUse } from "@/lib/agents/apiKeys";
import { OAUTH_ACCESS_PREFIX, touchGrantUse, verifyAccessToken } from "@/lib/agents/oauth";
import { agentFromRequest, agentLabel } from "@/lib/activity/log";
import { guardApiKeyRequest } from "@/lib/gating/actorRateLimit";
import type { Actor } from "@/lib/gating/actor";
import { isActiveMember } from "@/lib/gating/actor";

/** Client label stored on a key when the request carries no agent identification. */
export const UNKNOWN_AGENT_CLIENT = "API key";
/** What an OAuth grant shows where a key shows its first characters (`keyPrefix` in whoami, the Connect rows). */
export const OAUTH_DISPLAY_PREFIX = "signed in";

export type VerifiedApiKey = {
  /** Key id, or grant id for an OAuth token; stable across token refreshes, so sessions can bind to it. */
  id: string;
  kind: "key" | "oauth";
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  orgId: string;
  /** Uses recorded before this request (0 means this is the key's first ever use). */
  useCount: number;
  /** Client label of the previous use (before this one), or null. */
  lastUsedClient: string | null;
};

export type VerifyBearerFailureCode = "unauthorized" | "key_revoked" | "owner_removed" | "token_expired";

export type VerifyBearerResult =
  | { ok: true; actor: Extract<Actor, { kind: "user" }>; key: VerifiedApiKey }
  | { ok: false; code: VerifyBearerFailureCode };

/** Extract the bearer token from an `Authorization` header, or null. */
export function bearerTokenFromRequest(request: Request): string | null {
  const raw = request.headers.get("authorization") ?? "";
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  return m ? m[1] : null;
}

/** Client label for a request: agent label from `x-lnkdrp-agent` / User-Agent, else "API key". */
export function clientLabelFromRequest(request: Request): string {
  return agentLabel(agentFromRequest(request)) ?? UNKNOWN_AGENT_CLIENT;
}

/**
 * Pure token verification (no request, no usage bookkeeping): hash the token and look it up.
 *
 * Non-`lnk_` tokens and unknown keys are `unauthorized`; a known but revoked key is `key_revoked`.
 */
export async function verifyBearerToken(token: string | null | undefined): Promise<VerifyBearerResult> {
  if (typeof token === "string" && token.startsWith(OAUTH_ACCESS_PREFIX)) return verifyOAuthBearerToken(token);
  if (typeof token !== "string" || !token.startsWith(API_KEY_PREFIX)) return { ok: false, code: "unauthorized" };
  if (!looksLikeApiKey(token)) return { ok: false, code: "unauthorized" };

  await connectMongo();
  const doc = await ApiKeyModel.findOne({ keyHash: hashApiKey(token), isDeleted: { $ne: true } })
    .select({ orgId: 1, createdByUserId: 1, name: 1, prefix: 1, scopes: 1, revokedAt: 1, useCount: 1, lastUsedClient: 1 })
    .lean();
  if (!doc) return { ok: false, code: "unauthorized" };
  if (doc.revokedAt) return { ok: false, code: "key_revoked" };

  const orgId = String(doc.orgId);
  const userId = String(doc.createdByUserId);
  if (!Types.ObjectId.isValid(orgId) || !Types.ObjectId.isValid(userId)) return { ok: false, code: "unauthorized" };
  // The key owner's real personal workspace. It used to be set to the key's own org, so every
  // route that widens to legacy org-less data when `orgId === personalOrgId` did that for every
  // key - including a team workspace's key, which then saw its creator's old personal projects
  // and documents. "" when the owner has no personal org (never equal to a real orgId).
  /**
   * The key is only as good as its owner's membership.
   *
   * A key carries an `orgId` and the id of whoever created it, and it acts as that person. Checking
   * `revokedAt` alone meant removing someone from a workspace took away their browser session and
   * left their automation running with full access — indefinitely, since nothing expires a key.
   * That made "remove member" cosmetic for anyone who had ever created one.
   *
   * Cached with the session resolvers' membership cache, so revoking a membership invalidates this
   * too (`membershipChanged`) rather than leaving a ten-second window.
   */
  if (!(await isActiveMember({ orgId, userId }))) return { ok: false, code: "owner_removed" };

  const personalOrg = await OrgModel.findOne({ personalForUserId: new Types.ObjectId(userId) }).select({ _id: 1 }).lean();
  const personalOrgId = personalOrg ? String(personalOrg._id) : "";

  return {
    ok: true,
    // `viaApiKey` marks this actor as key-derived so gates that authorise on identity rather than
    // on a scope can refuse it — see `Actor` and `requireAdmin`.
    actor: {
      kind: "user",
      userId,
      orgId,
      personalOrgId,
      viaApiKey: { keyId: String(doc._id), scopes: (doc.scopes ?? []) as ApiKeyScope[] },
    },
    key: {
      id: String(doc._id),
      kind: "key",
      name: doc.name,
      prefix: doc.prefix,
      scopes: (doc.scopes ?? []) as ApiKeyScope[],
      orgId,
      useCount: typeof doc.useCount === "number" ? doc.useCount : 0,
      lastUsedClient: typeof doc.lastUsedClient === "string" ? doc.lastUsedClient : null,
    },
  };
}

/**
 * The OAuth half of `verifyBearerToken`: the grant is the key. Same membership rule (a grant acts
 * as the person who gave consent, and stops when they leave the workspace), same `Actor`.
 */
async function verifyOAuthBearerToken(token: string): Promise<VerifyBearerResult> {
  const verified = await verifyAccessToken(token);
  if (!verified.ok) return { ok: false, code: verified.code };
  const { grant } = verified;
  if (!Types.ObjectId.isValid(grant.orgId) || !Types.ObjectId.isValid(grant.userId)) return { ok: false, code: "unauthorized" };
  if (!(await isActiveMember({ orgId: grant.orgId, userId: grant.userId }))) return { ok: false, code: "owner_removed" };
  await connectMongo();
  const personalOrg = await OrgModel.findOne({ personalForUserId: new Types.ObjectId(grant.userId) }).select({ _id: 1 }).lean();
  return {
    ok: true,
    actor: {
      kind: "user",
      userId: grant.userId,
      orgId: grant.orgId,
      personalOrgId: personalOrg ? String(personalOrg._id) : "",
      viaApiKey: { keyId: grant.id, scopes: grant.scopes },
    },
    key: {
      id: grant.id,
      kind: "oauth",
      name: grant.clientName,
      prefix: OAUTH_DISPLAY_PREFIX,
      scopes: grant.scopes,
      orgId: grant.orgId,
      useCount: grant.useCount,
      lastUsedClient: grant.lastUsedClient,
    },
  };
}

/**
 * Verify the request's bearer token, charge it against the key's ceiling, and record the use.
 *
 * Returns the same shape as `verifyBearerToken`; `key.useCount` reflects the count before this use.
 *
 * Throws `ActorRateLimitError` when the key is over its ceiling. The charge lives here rather than
 * in `tryResolveApiKeyActor` so it also covers `GET /api/agent/whoami`, which authenticates the
 * key directly and never goes through the REST seam. It is charged only for a key that already
 * verified, so nobody can burn a real key's budget by guessing at it, and only once per `Request`.
 */
export async function verifyBearer(request: Request): Promise<VerifyBearerResult> {
  const result = await verifyBearerToken(bearerTokenFromRequest(request));
  if (!result.ok) return result;
  // Charged per key, not per IP: every agent's REST call leaves the MCP server from one address,
  // so an IP limit would make one runaway loop everybody else's problem.
  await guardApiKeyRequest(request, result.key.id);
  const client = clientLabelFromRequest(request);
  if (result.key.kind === "oauth") await touchGrantUse({ grantId: result.key.id, client });
  else await touchApiKeyUse({ keyId: result.key.id, client });
  return result;
}

/**
 * Thrown by `tryResolveApiKeyActor` when a request carries an `lnk_` bearer that is invalid,
 * revoked, or lacks the scope for the method. Routes that use `errorJson` map it to its status;
 * it must never fall through to a session or temp-user actor, because an agent presenting a bad
 * key would otherwise silently land in a fresh temporary workspace.
 */
export class ApiKeyAuthError extends Error {
  status: number;
  code: VerifyBearerFailureCode | "forbidden";
  constructor(code: VerifyBearerFailureCode | "forbidden", message: string) {
    super(message);
    this.name = "ApiKeyAuthError";
    this.code = code;
    this.status = code === "forbidden" ? 403 : 401;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * REST seam: when the request carries `Authorization: Bearer lnk_…`, resolve the key to an actor
 * for the key's workspace (and record the use, with the client from `x-lnkdrp-agent`). Returns
 * null when there is no `lnk_` bearer so the normal session / temp-user resolution runs. Keys
 * without the `write` scope are refused on mutating methods.
 *
 * This is what lets the MCP server (and any script) drive the same API the web app uses.
 */
export async function tryResolveApiKeyActor(request: Request): Promise<Actor | null> {
  const token = bearerTokenFromRequest(request);
  // Anything that claims to be a key is judged as one: a malformed `lnk_…` must 401, never fall
  // through to a session or a fresh temp workspace.
  if (!token || !(token.startsWith(API_KEY_PREFIX) || token.startsWith(OAUTH_ACCESS_PREFIX))) return null;
  const result = await verifyBearer(request);
  if (!result.ok) {
    // Distinct message per cause: an agent told "invalid key" when the real answer is "the person
    // who made this key is no longer in the workspace" will retry forever with a good key.
    const oauth = token.startsWith(OAUTH_ACCESS_PREFIX);
    const message =
      result.code === "key_revoked"
        ? oauth
          ? "This connection was revoked. Connect again from the app."
          : "This API key was revoked."
        : result.code === "owner_removed"
          ? "The member who connected this agent is no longer in this workspace."
          : result.code === "token_expired"
            ? "The access token has expired. Refresh it."
            : oauth
              ? "Invalid access token."
              : "Invalid API key.";
    throw new ApiKeyAuthError(result.code, message);
  }
  const method = (request.method || "GET").toUpperCase();
  if (MUTATING.has(method) && !result.key.scopes.includes("write")) {
    throw new ApiKeyAuthError("forbidden", "This API key is read-only.");
  }
  return result.actor;
}
