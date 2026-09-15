import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The two ceilings on unauthenticated / agent resource use.
 *
 * What matters here is the shape of the charge, not the counting: `rateLimit` is the shared
 * Mongo-backed limiter and has its own tests (`rateLimit.test.ts`). These pin the bucket keys,
 * the per-`Request` memo on the API-key guard — without it a key's real ceiling would depend on
 * which resolver combination a route happens to use — and the 429 the routes return.
 */
const { rateLimit } = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 1, retryAfterSec: 0 })),
}));

vi.mock("@/lib/http/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rateLimit")>()),
  rateLimit,
}));

const {
  ActorRateLimitError,
  API_KEY_REQUEST_LIMIT,
  actorRateLimitResponse,
  guardApiKeyRequest,
  guardTempWorkspaceCreation,
  TEMP_WORKSPACE_CREATE_LIMIT,
} = await import("@/lib/gating/actorRateLimit");

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/docs", { headers });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guardTempWorkspaceCreation", () => {
  test("charges the client IP with the configured ceiling", async () => {
    await guardTempWorkspaceCreation(req({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }));

    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "temp-workspace:198.51.100.4", limit: TEMP_WORKSPACE_CREATE_LIMIT }),
    );
  });

  test("collapses callers with no forwarding header into one bucket", async () => {
    await guardTempWorkspaceCreation(req());

    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "temp-workspace:unknown" }));
  });

  test("throws a 429 carrying the limiter's retry window", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterSec: 900 });

    await expect(guardTempWorkspaceCreation(req())).rejects.toMatchObject({
      status: 429,
      code: "temp_workspace_rate_limited",
      retryAfterSec: 900,
    });
  });
});

describe("guardApiKeyRequest", () => {
  test("charges the key, not the address it arrived from", async () => {
    await guardApiKeyRequest(req({ "x-forwarded-for": "198.51.100.4" }), "key-123");

    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "api-key:key-123", limit: API_KEY_REQUEST_LIMIT }),
    );
  });

  test("charges once per Request however many resolvers ask", async () => {
    const request = req();

    await guardApiKeyRequest(request, "key-123");
    await guardApiKeyRequest(request, "key-123");
    await guardApiKeyRequest(request, "key-123");

    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  test("keeps refusing for the rest of a Request once the key is over", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterSec: 30 });
    const request = req();

    await expect(guardApiKeyRequest(request, "key-123")).rejects.toBeInstanceOf(ActorRateLimitError);
    await expect(guardApiKeyRequest(request, "key-123")).rejects.toMatchObject({
      status: 429,
      code: "api_key_rate_limited",
    });
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  test("counts separate requests separately", async () => {
    await guardApiKeyRequest(req(), "key-123");
    await guardApiKeyRequest(req(), "key-123");

    expect(rateLimit).toHaveBeenCalledTimes(2);
  });
});

describe("actorRateLimitResponse", () => {
  test("answers 429 with Retry-After and a code an agent can branch on", async () => {
    const res = actorRateLimitResponse(new ActorRateLimitError("api_key_rate_limited", "over", 30));

    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("30");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    await expect(res?.json()).resolves.toMatchObject({ error: "api_key_rate_limited", retryAfterSeconds: 30 });
  });

  test("leaves every other error alone", () => {
    expect(actorRateLimitResponse(new Error("boom"))).toBeNull();
    expect(actorRateLimitResponse(null)).toBeNull();
  });
});
