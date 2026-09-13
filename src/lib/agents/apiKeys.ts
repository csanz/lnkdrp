/**
 * Agent API keys: minting, listing, revoking and usage tracking.
 *
 * A key is `lnk_` + 32 base62 chars (36 chars total). The plaintext is returned exactly once from
 * `createApiKey()` and never stored or logged; lookups go through the sha256 `keyHash`, so a
 * constant-time compare is unnecessary (an attacker cannot observe hash-lookup timing per byte).
 *
 * Pure helpers (`generateApiKeyPlaintext`, `hashApiKey`, `apiKeyPrefix`, `looksLikeApiKey`,
 * `toAgentKeyRow`) have no Mongo dependency and are unit-tested in `tests/lib/apiKeys.test.ts`.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { newSecretToken } from "@/lib/crypto/randomBase62";
import { API_KEY_SCOPES, ApiKeyModel, type ApiKeyScope } from "@/lib/models/ApiKey";
import { UserModel } from "@/lib/models/User";
import type { AgentClient, AgentKeyRow, AgentStatus } from "@/lib/client/useAgentStatus";
import { debugLog } from "@/lib/debug";

export const API_KEY_PREFIX = "lnk_";
/** Random base62 chars after the `lnk_` prefix. */
export const API_KEY_SECRET_LENGTH = 32;
/** Total plaintext length (`lnk_` + secret). */
export const API_KEY_LENGTH = API_KEY_PREFIX.length + API_KEY_SECRET_LENGTH;
/** Chars of the plaintext kept for display, e.g. `lnk_ab12cd34`. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
export const API_KEY_NAME_MAX_LENGTH = 60;
/** Maximum non-revoked keys per workspace. */
export const API_KEY_MAX_ACTIVE_PER_ORG = 10;
/** Maximum rows returned by `listApiKeys()`. */
export const API_KEY_LIST_LIMIT = 50;
/** `touchApiKeyUse()` writes at most once per key per this interval (per process). */
export const API_KEY_TOUCH_THROTTLE_MS = 60_000;

const API_KEY_RE = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${API_KEY_SECRET_LENGTH}}$`);

/** Mint a new plaintext key: `lnk_` + 32 base62 chars. */
export function generateApiKeyPlaintext(): string {
  return `${API_KEY_PREFIX}${newSecretToken(API_KEY_SECRET_LENGTH)}`;
}

/** sha256 hex of the full plaintext key; this is what is stored and looked up. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Display prefix (first 12 chars), e.g. `lnk_ab12cd34`. */
export function apiKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** Whether `token` has the exact shape of a lnkdrp API key (`lnk_` + 32 base62 chars). */
export function looksLikeApiKey(token: unknown): token is string {
  return typeof token === "string" && API_KEY_RE.test(token);
}

/** Normalise a caller-supplied scopes array; `undefined` when absent, `null` when invalid. */
export function normalizeScopes(input: unknown): ApiKeyScope[] | null | undefined {
  if (typeof input === "undefined" || input === null) return undefined;
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: ApiKeyScope[] = [];
  for (const s of input) {
    if (typeof s !== "string" || !(API_KEY_SCOPES as readonly string[]).includes(s)) return null;
    if (!out.includes(s as ApiKeyScope)) out.push(s as ApiKeyScope);
  }
  return out;
}

/** Minimal document shape `toAgentKeyRow()` needs (works for both hydrated and lean docs). */
export type ApiKeyRowSource = {
  _id: Types.ObjectId | string;
  name: string;
  prefix: string;
  scopes?: readonly string[] | null;
  createdDate?: Date | string | null;
  lastUsedAt?: Date | string | null;
  lastUsedClient?: string | null;
  revokedAt?: Date | string | null;
  createdByUserId?: Types.ObjectId | string | null;
};

/** Owner display info resolved from `User` for `createdBy`. */
export type KeyOwner = { id: string; name: string | null; email: string | null };

/** ISO string for a Date/string, or null when missing/invalid. */
function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Project an ApiKey document into the client `AgentKeyRow` shape (never includes the hash). */
export function toAgentKeyRow(doc: ApiKeyRowSource, owner: KeyOwner | null = null): AgentKeyRow {
  const scopes = (doc.scopes ?? []).filter((s): s is ApiKeyScope =>
    (API_KEY_SCOPES as readonly string[]).includes(s),
  );
  return {
    id: String(doc._id),
    name: doc.name,
    prefix: doc.prefix,
    scopes,
    createdAt: toIso(doc.createdDate) ?? new Date(0).toISOString(),
    lastUsedAt: toIso(doc.lastUsedAt),
    lastUsedClient: doc.lastUsedClient ?? null,
    revoked: Boolean(doc.revokedAt),
    createdBy: owner,
  };
}

/**
 * HTTP tools people use to check a key (the Verify step's curl above all). They prove the key
 * works but are not agents, so they count as "verified", never as "connected", and never appear
 * under Agents. Matched case-insensitively against the client label.
 */
const TOOL_CLIENTS = new Set(["curl", "wget", "httpie", "postman", "insomnia", "python-requests", "node-fetch", "undici", "axios", "fetch", "api key"]);
export function isToolClient(label: string | null | undefined): boolean {
  const l = (label ?? "").trim().toLowerCase();
  return l === "" || TOOL_CLIENTS.has(l);
}

/** Short display name for a key owner: name, else the part of the email before "@", else "a member". */
export function ownerLabel(owner: KeyOwner | null): string {
  if (!owner) return "a member";
  if (owner.name && owner.name.trim()) return owner.name.trim();
  if (owner.email) return owner.email.split("@")[0] || owner.email;
  return "a member";
}

/** Coerce a string/ObjectId into an ObjectId (callers validate ids first). */
function toObjectId(v: string | Types.ObjectId): Types.ObjectId {
  return v instanceof Types.ObjectId ? v : new Types.ObjectId(String(v));
}

export type CreateApiKeyInput = {
  orgId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  name: string;
  scopes?: ApiKeyScope[];
};

/**
 * Mint a key for `orgId`. Returns the plaintext exactly once; only the hash is stored.
 *
 * Callers validate `name` (1..60) and the active-key cap before calling; this only trims/clamps.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<{ plaintext: string; key: AgentKeyRow }> {
  const name = input.name.trim().slice(0, API_KEY_NAME_MAX_LENGTH);
  const scopes = input.scopes && input.scopes.length ? Array.from(new Set(input.scopes)) : [...API_KEY_SCOPES];
  const plaintext = generateApiKeyPlaintext();
  await connectMongo();
  const now = new Date();
  const doc = await ApiKeyModel.create({
    orgId: toObjectId(input.orgId),
    createdByUserId: toObjectId(input.userId),
    name,
    prefix: apiKeyPrefix(plaintext),
    keyHash: hashApiKey(plaintext),
    scopes,
    lastUsedAt: null,
    lastUsedClient: null,
    useCount: 0,
    revokedAt: null,
    isDeleted: false,
    createdDate: now,
    updatedDate: now,
  });
  return { plaintext, key: toAgentKeyRow(doc) };
}

/** Keys for a workspace, newest first, revoked included (`revoked: true`), capped at 50. */
/** Resolve `createdByUserId`s to display info in one query (missing users map to null). */
async function resolveOwners(ids: Array<Types.ObjectId | string | null>): Promise<Map<string, KeyOwner>> {
  const unique = Array.from(new Set(ids.filter(Boolean).map((v) => String(v)))).filter((v) => Types.ObjectId.isValid(v));
  const out = new Map<string, KeyOwner>();
  if (unique.length === 0) return out;
  const users = await UserModel.find({ _id: { $in: unique.map((v) => new Types.ObjectId(v)) } })
    .select({ name: 1, email: 1 })
    .lean();
  for (const u of users as Array<{ _id: Types.ObjectId; name?: string | null; email?: string | null }>) {
    out.set(String(u._id), { id: String(u._id), name: u.name ?? null, email: u.email ?? null });
  }
  return out;
}

export async function listApiKeys(orgId: string | Types.ObjectId): Promise<AgentKeyRow[]> {
  await connectMongo();
  const docs = await ApiKeyModel.find({ orgId: toObjectId(orgId), isDeleted: { $ne: true } })
    .sort({ createdDate: -1 })
    .limit(API_KEY_LIST_LIMIT)
    .select({ name: 1, prefix: 1, scopes: 1, createdDate: 1, lastUsedAt: 1, lastUsedClient: 1, revokedAt: 1, createdByUserId: 1 })
    .lean();
  const owners = await resolveOwners(docs.map((d) => (d as ApiKeyRowSource).createdByUserId ?? null));
  return docs.map((d) => {
    const src = d as ApiKeyRowSource;
    return toAgentKeyRow(src, src.createdByUserId ? (owners.get(String(src.createdByUserId)) ?? null) : null);
  });
}

/** Number of non-revoked keys in a workspace (for the per-org cap). */
export async function countActiveApiKeys(orgId: string | Types.ObjectId): Promise<number> {
  await connectMongo();
  return ApiKeyModel.countDocuments({ orgId: toObjectId(orgId), revokedAt: null, isDeleted: { $ne: true } });
}

/**
 * Revoke a key in place (sets `revokedAt`). Returns the revoked row, or `null` when the key does
 * not belong to `orgId`, is already revoked, or does not exist.
 */
export async function revokeApiKey(input: { orgId: string | Types.ObjectId; keyId: string }): Promise<AgentKeyRow | null> {
  if (!Types.ObjectId.isValid(input.keyId)) return null;
  await connectMongo();
  const doc = await ApiKeyModel.findOneAndUpdate(
    { _id: new Types.ObjectId(input.keyId), orgId: toObjectId(input.orgId), revokedAt: null, isDeleted: { $ne: true } },
    { $set: { revokedAt: new Date() } },
    { new: true },
  )
    .select({ name: 1, prefix: 1, scopes: 1, createdDate: 1, lastUsedAt: 1, lastUsedClient: 1, revokedAt: 1, createdByUserId: 1 })
    .lean();
  return doc ? toAgentKeyRow(doc as ApiKeyRowSource) : null;
}

/** Last write time per key id (process-local throttle for `touchApiKeyUse`). */
const touchedAt = new Map<string, number>();
const TOUCH_MAP_MAX = 1000;

/**
 * Record a use of `keyId`: `lastUsedAt = now`, `lastUsedClient = client`, `useCount += 1`.
 *
 * Best-effort and throttled to one write per key per 60s per process. Never throws.
 */
export async function touchApiKeyUse(input: { keyId: string; client: string | null }): Promise<void> {
  try {
    const now = Date.now();
    const last = touchedAt.get(input.keyId);
    if (typeof last === "number" && now - last < API_KEY_TOUCH_THROTTLE_MS) return;
    touchedAt.set(input.keyId, now);
    if (touchedAt.size > TOUCH_MAP_MAX) {
      const oldest = touchedAt.keys().next().value;
      if (oldest) touchedAt.delete(oldest);
    }
    if (!Types.ObjectId.isValid(input.keyId)) return;
    await connectMongo();
    await ApiKeyModel.updateOne(
      { _id: new Types.ObjectId(input.keyId) },
      { $set: { lastUsedAt: new Date(now), lastUsedClient: input.client ?? null }, $inc: { useCount: 1 } },
    );
  } catch (err) {
    debugLog(1, "[agents/apiKeys] touchApiKeyUse failed", {
      keyId: input.keyId,
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

/** Test hook: clear the process-local touch throttle. */
export function resetApiKeyTouchThrottle(): void {
  touchedAt.clear();
}

/**
 * Workspace agent status (without `canManage`, which depends on the caller's role).
 *
 * `connected` is true once any ACTIVE key has been used at least once. Revoked keys do not count,
 * so a workspace that revokes every key goes back to "Not connected" instead of showing a stale
 * green dot forever; their history stays visible in the key list.
 */
export async function getAgentStatus(orgId: string | Types.ObjectId): Promise<Omit<AgentStatus, "canManage" | "isPersonalOrg">> {
  const keys = await listApiKeys(orgId);
  // `latest` = most recent use by an agent client; `latestTool` = most recent use by curl & co.
  let latest: AgentKeyRow | null = null;
  let latestTool: AgentKeyRow | null = null;
  for (const k of keys) {
    if (!k.lastUsedAt || k.revoked) continue;
    if (isToolClient(k.lastUsedClient)) {
      if (!latestTool || (latestTool.lastUsedAt ?? "") < k.lastUsedAt) latestTool = k;
      continue;
    }
    if (!latest || (latest.lastUsedAt ?? "") < k.lastUsedAt) latest = k;
  }
  // Distinct connected clients across active, used keys (a client may hold several keys, and in a
  // shared workspace several members may each connect the same client).
  const byClient = new Map<string, AgentClient>();
  for (const k of keys) {
    if (!k.lastUsedAt || k.revoked || isToolClient(k.lastUsedClient)) continue;
    const name = k.lastUsedClient ?? "API key";
    const who = ownerLabel(k.createdBy);
    const cur = byClient.get(name);
    if (!cur) byClient.set(name, { client: name, lastUsedAt: k.lastUsedAt, keys: 1, by: [who] });
    else {
      cur.keys += 1;
      if (cur.lastUsedAt < k.lastUsedAt) cur.lastUsedAt = k.lastUsedAt;
      if (!cur.by.includes(who)) cur.by.push(who);
    }
  }
  const clients = Array.from(byClient.values()).sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  return {
    connected: latest !== null,
    verified: latest !== null || latestTool !== null,
    lastVerified: latestTool?.lastUsedAt ? { at: latestTool.lastUsedAt, client: latestTool.lastUsedClient ?? "API key" } : null,
    lastUsedAt: latest?.lastUsedAt ?? null,
    lastUsedClient: latest?.lastUsedClient ?? null,
    activeKeys: keys.filter((k) => !k.revoked).length,
    keys,
    clients,
    connectedCount: clients.length,
  };
}
