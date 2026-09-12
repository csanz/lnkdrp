import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * In-memory stand-in for the `ratelimits` collection that honours the two query shapes the
 * limiter uses, including the unique-key collision (E11000) that signals an expired bucket.
 */
type Bucket = { key: string; count: number; windowStart: Date; expiresAt: Date };
const store = new Map<string, Bucket>();

function dupKeyError() {
  const err = new Error("E11000 duplicate key error collection: ratelimits index: key_1") as Error & { code: number };
  err.code = 11000;
  return err;
}

const findOneAndUpdate = vi.fn(
  (
    filter: { key: string; expiresAt: { $gt?: Date; $lte?: Date } },
    update: { $inc?: { count: number }; $setOnInsert?: Partial<Bucket>; $set?: Partial<Bucket> },
    opts: { upsert?: boolean; new?: boolean },
  ) => {
    const existing = store.get(filter.key) ?? null;
    const gt = filter.expiresAt.$gt;
    const lte = filter.expiresAt.$lte;
    const matches =
      existing !== null &&
      (gt ? existing.expiresAt.getTime() > gt.getTime() : true) &&
      (lte ? existing.expiresAt.getTime() <= lte.getTime() : true);

    let result: Bucket | null = null;
    if (matches && existing) {
      if (update.$inc) existing.count += update.$inc.count;
      if (update.$set) Object.assign(existing, update.$set);
      result = existing;
    } else if (opts.upsert) {
      if (existing) throw dupKeyError(); // unique index on `key`
      const created: Bucket = { ...(update.$setOnInsert as Bucket), count: update.$inc?.count ?? 0 };
      store.set(filter.key, created);
      result = created;
    }
    return { lean: async () => (result ? { ...result } : null) };
  },
);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/RateLimit", () => ({ RateLimitModel: { findOneAndUpdate } }));

const { rateLimit, clientIpFromRequest } = await import("@/lib/http/rateLimit");

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("http/rateLimit.rateLimit", () => {
  beforeEach(() => {
    store.clear();
    findOneAndUpdate.mockClear();
  });

  test("counts hits within a window and blocks past the limit", async () => {
    const args = { key: "t:a", limit: 3, windowMs: 60_000 };
    expect(await rateLimit({ ...args, now: T0 })).toEqual({ ok: true, remaining: 2, retryAfterSec: 0 });
    expect(await rateLimit({ ...args, now: T0 + 1000 })).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    expect(await rateLimit({ ...args, now: T0 + 2000 })).toEqual({ ok: true, remaining: 0, retryAfterSec: 0 });

    const blocked = await rateLimit({ ...args, now: T0 + 30_000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    // Window closes at T0 + 60s; 30s remain.
    expect(blocked.retryAfterSec).toBe(30);
    // Hot path is one atomic call per hit.
    expect(findOneAndUpdate).toHaveBeenCalledTimes(4);
  });

  test("resets an expired bucket in place (dup-key -> reset path)", async () => {
    const args = { key: "t:b", limit: 2, windowMs: 60_000 };
    await rateLimit({ ...args, now: T0 });
    await rateLimit({ ...args, now: T0 });
    expect((await rateLimit({ ...args, now: T0 })).ok).toBe(false);
    findOneAndUpdate.mockClear();

    // Window elapsed but TTL hasn't reaped the doc yet: first attempt collides, reset opens a new window.
    const later = T0 + 61_000;
    const res = await rateLimit({ ...args, now: later });
    expect(res).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdate.mock.calls[1]?.[0]).toEqual({ key: "t:b", expiresAt: { $lte: new Date(later) } });

    const bucket = store.get("t:b");
    expect(bucket?.count).toBe(1);
    expect(bucket?.windowStart.getTime()).toBe(later);
    expect(bucket?.expiresAt.getTime()).toBe(later + 60_000);
  });

  test("retries the hot path when another request reset the bucket first", async () => {
    const args = { key: "t:c", limit: 5, windowMs: 60_000 };
    await rateLimit({ ...args, now: T0 });
    findOneAndUpdate.mockClear();

    // Simulate a concurrent reset: our upsert collides, our reset matches nothing (window already
    // fresh), then the retried upsert increments the fresh window.
    const later = T0 + 61_000;
    findOneAndUpdate.mockImplementationOnce((filter) => {
      // Collide, and let a "concurrent" request reset the bucket before our own reset runs.
      const b = store.get(filter.key)!;
      b.count = 1;
      b.windowStart = new Date(later);
      b.expiresAt = new Date(later + 60_000);
      throw dupKeyError();
    });
    const res = await rateLimit({ ...args, now: later });
    expect(res).toEqual({ ok: true, remaining: 3, retryAfterSec: 0 });
    expect(store.get("t:c")?.count).toBe(2);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);
  });

  test("fails open when the store throws an unexpected error", async () => {
    findOneAndUpdate.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const res = await rateLimit({ key: "t:d", limit: 2, windowMs: 1000, now: T0 });
    expect(res).toEqual({ ok: true, remaining: 2, retryAfterSec: 0 });
  });
});

describe("http/rateLimit.clientIpFromRequest", () => {
  test("prefers the first x-forwarded-for hop, then x-real-ip, else unknown", () => {
    const mk = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(clientIpFromRequest(mk({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIpFromRequest(mk({ "x-forwarded-for": "203.0.113.9:4321" }))).toBe("203.0.113.9");
    expect(clientIpFromRequest(mk({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIpFromRequest(mk({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIpFromRequest(mk({ "x-forwarded-for": "  ", "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIpFromRequest(mk({}))).toBe("unknown");
  });
});
