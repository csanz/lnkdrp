/**
 * Bearer-token auth seam for agent / MCP clients.
 *
 * `verifyBearer(request)` reads `Authorization: Bearer <token>`. Tokens starting with `lnk_` are
 * workspace API keys (see `src/lib/agents/apiKeys.ts`): the token is sha256-hashed and looked up by
 * `keyHash`; on success the caller gets a regular `Actor` (`kind: "user"`, attributed to the member
 * who minted the key, scoped to the key's workspace) plus the key's id/scopes. Any other token
 * shape is rejected as `unauthorized` today; this is the seam where OAuth tokens will plug in.
 *
 * The plaintext token is never logged. The MCP server calls `verifyBearer` on every request; the
 * web app uses it only on `GET /api/agent/whoami` (no session / temp-user fallback there).
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { ApiKeyModel, type ApiKeyScope } from "@/lib/models/ApiKey";
import { API_KEY_PREFIX, hashApiKey, looksLikeApiKey, touchApiKeyUse } from "@/lib/agents/apiKeys";
import { agentFromRequest, agentLabel } from "@/lib/activity/log";
import type { Actor } from "@/lib/gating/actor";

/** Client label stored on a key when the request carries no agent identification. */
export const UNKNOWN_AGENT_CLIENT = "API key";

export type VerifiedApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  orgId: string;
  /** Uses recorded before this request (0 means this is the key's first ever use). */
  useCount: number;
  /** Client label of the previous use (before this one), or null. */
  lastUsedClient: string | null;
};

export type VerifyBearerFailureCode = "unauthorized" | "key_revoked";

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

  return {
    ok: true,
    actor: { kind: "user", userId, orgId, personalOrgId: orgId },
    key: {
      id: String(doc._id),
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
 * Verify the request's bearer token and record the use (best-effort, throttled).
 *
 * Returns the same shape as `verifyBearerToken`; `key.useCount` reflects the count before this use.
 */
export async function verifyBearer(request: Request): Promise<VerifyBearerResult> {
  const result = await verifyBearerToken(bearerTokenFromRequest(request));
  if (!result.ok) return result;
  await touchApiKeyUse({ keyId: result.key.id, client: clientLabelFromRequest(request) });
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
  code: "unauthorized" | "key_revoked" | "forbidden";
  constructor(code: "unauthorized" | "key_revoked" | "forbidden", message: string) {
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
  if (!token || !token.startsWith(API_KEY_PREFIX)) return null;
  const result = await verifyBearer(request);
  if (!result.ok) {
    throw new ApiKeyAuthError(result.code, result.code === "key_revoked" ? "This API key was revoked." : "Invalid API key.");
  }
  const method = (request.method || "GET").toUpperCase();
  if (MUTATING.has(method) && !result.key.scopes.includes("write")) {
    throw new ApiKeyAuthError("forbidden", "This API key is read-only.");
  }
  return result.actor;
}
