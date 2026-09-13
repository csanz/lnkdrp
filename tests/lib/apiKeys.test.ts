import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { Types } from "mongoose";

const apiKeyFindOne = vi.fn();
const apiKeyUpdateOne = vi.fn();
const connectMongo = vi.fn(async () => undefined);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { create: vi.fn() } }));
vi.mock("@/lib/models/ApiKey", () => ({
  API_KEY_SCOPES: ["read", "write"],
  ApiKeyModel: { findOne: apiKeyFindOne, updateOne: apiKeyUpdateOne },
}));

const {
  API_KEY_LENGTH,
  API_KEY_PREFIX,
  apiKeyPrefix,
  generateApiKeyPlaintext,
  hashApiKey,
  looksLikeApiKey,
  normalizeScopes,
  resetApiKeyTouchThrottle,
  toAgentKeyRow,
  touchApiKeyUse,
} = await import("@/lib/agents/apiKeys");
const { verifyBearer, verifyBearerToken, bearerTokenFromRequest, clientLabelFromRequest } = await import(
  "@/lib/gating/apiKeyActor"
);

const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const KEY_ID = new Types.ObjectId();

/** Make `ApiKeyModel.findOne().select().lean()` resolve to `doc`. */
function lookup(doc: Record<string, unknown> | null) {
  apiKeyFindOne.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}

/** A lean ApiKey document as the auth seam reads it. */
function keyDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: KEY_ID,
    orgId: ORG,
    createdByUserId: USER,
    name: "Claude Code on my laptop",
    prefix: "lnk_ab12cd34",
    scopes: ["read", "write"],
    revokedAt: null,
    useCount: 0,
    ...overrides,
  };
}

describe("agents/apiKeys key format", () => {
  test("generates `lnk_` + 32 base62 chars (36 total) and every key is unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = generateApiKeyPlaintext();
      expect(k.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(k).toHaveLength(API_KEY_LENGTH);
      expect(k).toHaveLength(36);
      expect(k).toMatch(/^lnk_[0-9A-Za-z]{32}$/);
      expect(looksLikeApiKey(k)).toBe(true);
      seen.add(k);
    }
    expect(seen.size).toBe(50);
  });

  test("hashApiKey is sha256 hex of the plaintext", () => {
    const k = generateApiKeyPlaintext();
    expect(hashApiKey(k)).toBe(createHash("sha256").update(k).digest("hex"));
    expect(hashApiKey(k)).toHaveLength(64);
    expect(hashApiKey(k)).not.toBe(hashApiKey(`${k.slice(0, -1)}x`));
  });

  test("apiKeyPrefix keeps the first 12 chars", () => {
    expect(apiKeyPrefix("lnk_ab12cd34EFGH5678ijkl9012MNOP3456")).toBe("lnk_ab12cd34");
    expect(apiKeyPrefix(generateApiKeyPlaintext())).toHaveLength(12);
  });

  test("looksLikeApiKey rejects wrong prefix, length, charset and non-strings", () => {
    expect(looksLikeApiKey("sk_" + "a".repeat(32))).toBe(false);
    expect(looksLikeApiKey("lnk_" + "a".repeat(31))).toBe(false);
    expect(looksLikeApiKey("lnk_" + "a".repeat(33))).toBe(false);
    expect(looksLikeApiKey("lnk_" + "a".repeat(31) + "!")).toBe(false);
    expect(looksLikeApiKey("lnk_" + "a".repeat(31) + " ")).toBe(false);
    expect(looksLikeApiKey(null)).toBe(false);
    expect(looksLikeApiKey(42)).toBe(false);
  });

  test("normalizeScopes dedupes, validates and distinguishes absent from invalid", () => {
    expect(normalizeScopes(undefined)).toBeUndefined();
    expect(normalizeScopes(null)).toBeUndefined();
    expect(normalizeScopes(["read", "read", "write"])).toEqual(["read", "write"]);
    expect(normalizeScopes(["read"])).toEqual(["read"]);
    expect(normalizeScopes([])).toBeNull();
    expect(normalizeScopes(["admin"])).toBeNull();
    expect(normalizeScopes("read")).toBeNull();
  });

  test("toAgentKeyRow projects a document without leaking the hash", () => {
    const created = new Date("2026-09-01T10:00:00.000Z");
    const row = toAgentKeyRow({
      _id: KEY_ID,
      name: "Cursor",
      prefix: "lnk_zz",
      scopes: ["read", "bogus"],
      createdDate: created,
      lastUsedAt: null,
      lastUsedClient: null,
      revokedAt: new Date("2026-09-02T00:00:00.000Z"),
      // @ts-expect-error extra field must be dropped
      keyHash: "secret",
    });
    expect(row).toEqual({
      id: String(KEY_ID),
      name: "Cursor",
      prefix: "lnk_zz",
      scopes: ["read"],
      createdAt: created.toISOString(),
      lastUsedAt: null,
      lastUsedClient: null,
      revoked: true,
    });
    expect("keyHash" in row).toBe(false);
  });
});

describe("gating/apiKeyActor.bearerTokenFromRequest", () => {
  test("extracts the token case-insensitively and trims whitespace", () => {
    expect(bearerTokenFromRequest(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(bearerTokenFromRequest(new Request("http://x", { headers: { Authorization: "bearer   abc  " } }))).toBe("abc");
    expect(bearerTokenFromRequest(new Request("http://x", { headers: { authorization: "Basic abc" } }))).toBeNull();
    expect(bearerTokenFromRequest(new Request("http://x"))).toBeNull();
  });

  test("clientLabelFromRequest uses x-lnkdrp-agent and falls back to 'API key'", () => {
    expect(clientLabelFromRequest(new Request("http://x", { headers: { "x-lnkdrp-agent": "claude-code/1.2" } }))).toBe(
      "Claude Code",
    );
    expect(clientLabelFromRequest(new Request("http://x", { headers: { "user-agent": "curl/8.0" } }))).toBe("API key");
  });
});

describe("gating/apiKeyActor.verifyBearerToken", () => {
  beforeEach(() => {
    apiKeyFindOne.mockReset();
    apiKeyUpdateOne.mockReset();
    apiKeyUpdateOne.mockResolvedValue({ acknowledged: true });
    connectMongo.mockClear();
    resetApiKeyTouchThrottle();
  });

  test("rejects non-lnk_ and malformed tokens without touching the database", async () => {
    expect(await verifyBearerToken("oauth_something")).toEqual({ ok: false, code: "unauthorized" });
    expect(await verifyBearerToken("lnk_short")).toEqual({ ok: false, code: "unauthorized" });
    expect(await verifyBearerToken(null)).toEqual({ ok: false, code: "unauthorized" });
    expect(await verifyBearerToken(undefined)).toEqual({ ok: false, code: "unauthorized" });
    expect(apiKeyFindOne).not.toHaveBeenCalled();
    expect(connectMongo).not.toHaveBeenCalled();
  });

  test("looks the key up by sha256 hash and returns a user actor scoped to the key's org", async () => {
    const plaintext = generateApiKeyPlaintext();
    lookup(keyDoc());

    const result = await verifyBearerToken(plaintext);
    expect(apiKeyFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ keyHash: hashApiKey(plaintext), isDeleted: { $ne: true } }),
    );
    expect(result).toEqual({
      ok: true,
      actor: { kind: "user", userId: String(USER), orgId: String(ORG), personalOrgId: String(ORG) },
      key: {
        id: String(KEY_ID),
        name: "Claude Code on my laptop",
        prefix: "lnk_ab12cd34",
        scopes: ["read", "write"],
        orgId: String(ORG),
        useCount: 0,
      },
    });
  });

  test("returns unauthorized for unknown keys and key_revoked for revoked ones", async () => {
    lookup(null);
    expect(await verifyBearerToken(generateApiKeyPlaintext())).toEqual({ ok: false, code: "unauthorized" });

    lookup(keyDoc({ revokedAt: new Date() }));
    expect(await verifyBearerToken(generateApiKeyPlaintext())).toEqual({ ok: false, code: "key_revoked" });
  });

  test("verifyBearer reads the Authorization header and records the use with the client label", async () => {
    const plaintext = generateApiKeyPlaintext();
    lookup(keyDoc({ useCount: 3 }));
    const req = new Request("http://localhost/api/agent/whoami", {
      headers: { authorization: `Bearer ${plaintext}`, "x-lnkdrp-agent": "cursor/0.45" },
    });

    const result = await verifyBearer(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key.useCount).toBe(3);
    expect(apiKeyUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = apiKeyUpdateOne.mock.calls[0] as [
      { _id: unknown },
      { $set: { lastUsedAt: unknown; lastUsedClient: unknown }; $inc: unknown },
    ];
    expect(String(filter._id)).toBe(String(KEY_ID));
    expect(update.$set.lastUsedClient).toBe("Cursor");
    expect(update.$set.lastUsedAt).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ useCount: 1 });
  });

  test("verifyBearer does not touch usage when the key is revoked or missing", async () => {
    lookup(keyDoc({ revokedAt: new Date() }));
    const req = new Request("http://localhost/api/agent/whoami", {
      headers: { authorization: `Bearer ${generateApiKeyPlaintext()}` },
    });
    expect(await verifyBearer(req)).toEqual({ ok: false, code: "key_revoked" });
    expect(await verifyBearer(new Request("http://localhost/api/agent/whoami"))).toEqual({
      ok: false,
      code: "unauthorized",
    });
    expect(apiKeyUpdateOne).not.toHaveBeenCalled();
  });

  test("touchApiKeyUse is throttled per key and never throws", async () => {
    const keyId = String(new Types.ObjectId());
    await touchApiKeyUse({ keyId, client: "Codex" });
    await touchApiKeyUse({ keyId, client: "Codex" });
    expect(apiKeyUpdateOne).toHaveBeenCalledTimes(1);

    await touchApiKeyUse({ keyId: String(new Types.ObjectId()), client: null });
    expect(apiKeyUpdateOne).toHaveBeenCalledTimes(2);

    resetApiKeyTouchThrottle();
    apiKeyUpdateOne.mockRejectedValueOnce(new Error("mongo down"));
    await expect(touchApiKeyUse({ keyId, client: "Codex" })).resolves.toBeUndefined();
  });
});
