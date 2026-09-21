/**
 * Guessing a share password used to be a matter of renting a few addresses.
 *
 * `POST /api/share/:shareId/unlock` counted attempts in one bucket, `unlock:<ip>:<shareId>` — ten
 * per five minutes, which reads like a brute-force bound but is only a bound on *one source*. Ten
 * cheap proxies bought ten times the guesses against the same link, and share passwords have no
 * minimum length by design (`SHARE_PASSWORD_MIN = 1`; the limiter is what the product leans on
 * instead of a length rule). Nothing else stood in the way: a wrong password is a bare 401, no
 * failure is counted, and the prize is a 14-day httpOnly cookie scoped to `/`.
 *
 * So these tests are written from the attacker's seat: the guesses arrive from addresses that have
 * never been seen before, which is exactly the case the old key could not see. They assert on the
 * limiter keys the route issues and on what happens when a bucket is exhausted — the link's own
 * budget has to refuse a caller whose address is spotless, and a wrong password has to cost that
 * budget more than a right one, or a crowd of real recipients would hit the ceiling first.
 *
 * The last test is the other half: a recipient with the password still gets in, with their cookie.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { resolveShareLink, resolveProjectLink, recordActivity, tryResolveAuthUserId, isOwnerSideViewer } = vi.hoisted(
  () => ({
    resolveShareLink: vi.fn(),
    resolveProjectLink: vi.fn(async () => null),
    recordActivity: vi.fn(),
    tryResolveAuthUserId: vi.fn(async () => null),
    isOwnerSideViewer: vi.fn(async () => false),
  }),
);

/**
 * A stand-in for the Mongo-backed limiter: it records every bucket the route asks for and reports
 * whichever ones the test has declared exhausted. Keys are the assertion surface — a limiter that
 * never names the share cannot bound an attack spread across addresses.
 */
const { limiterCalls, exhausted, rateLimit, clientIpFromRequest, rateLimitedResponse } = vi.hoisted(() => {
  const limiterCalls: { key: string; limit: number; windowMs: number }[] = [];
  const exhausted = new Set<string>();
  return {
    limiterCalls,
    exhausted,
    rateLimit: vi.fn(async (input: { key: string; limit: number; windowMs: number }) => {
      limiterCalls.push({ key: input.key, limit: input.limit, windowMs: input.windowMs });
      const ok = !exhausted.has(input.key);
      return { ok, remaining: ok ? input.limit - 1 : 0, retryAfterSec: ok ? 0 : 120 };
    }),
    // The real helper reads `x-forwarded-for`; keeping that here is what lets a test play the
    // attacker who has just moved to a fresh proxy.
    clientIpFromRequest: vi.fn((request: Request) => request.headers.get("x-forwarded-for") ?? "203.0.113.7"),
    rateLimitedResponse: vi.fn(
      (result: { retryAfterSec: number }, message = "Too many requests. Please try again later.") =>
        new Response(JSON.stringify({ error: message, retryAfterSeconds: result.retryAfterSec }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ),
  };
});

vi.mock("@/lib/http/rateLimit", () => ({ rateLimit, clientIpFromRequest, rateLimitedResponse }));
vi.mock("@/lib/share/links", () => ({ resolveShareLink }));
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink }));
vi.mock("@/lib/activity/log", () => ({ recordActivity }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugWarn: vi.fn(), debugError: vi.fn() }));

const { POST } = await import("@/app/api/share/[shareId]/unlock/route");
// The real scrypt hashing — a test that mocked it would be testing the mock, and the route's
// failure path is precisely "the hash did not match".
const { hashSharePassword, shareAuthCookieName } = await import("@/lib/sharePassword");

const SHARE_ID = "srDP4SzZNA5a";
const PASSWORD = "ostrich-9";
const { salt, hash } = hashSharePassword(PASSWORD);

/** The share bucket: one budget for the link, whoever is spending it. */
const shareKey = (shareId = SHARE_ID) => `unlock:share:${shareId}`;
const keysFor = (prefix: string) => limiterCalls.filter((c) => c.key.startsWith(prefix)).map((c) => c.key);

function protectedLink(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    shareId: SHARE_ID,
    orgId: new Types.ObjectId(),
    docId: new Types.ObjectId(),
    createdByUserId: new Types.ObjectId(),
    label: "Sequoia",
    isDefault: true,
    passwordHash: hash,
    passwordSalt: salt,
    ...overrides,
  };
}

/** One unlock attempt. `ip` is the address the proxy in front of the app reports. */
function unlock(opts: { password?: string; ip?: string; shareId?: string } = {}) {
  const shareId = opts.shareId ?? SHARE_ID;
  return POST(
    new Request(`https://lnkdrp.test/api/share/${shareId}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
      },
      body: JSON.stringify({ password: opts.password ?? PASSWORD }),
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  limiterCalls.length = 0;
  exhausted.clear();
  resolveShareLink.mockResolvedValue({ link: protectedLink(), doc: { _id: new Types.ObjectId() }, refusal: null });
  resolveProjectLink.mockResolvedValue(null);
  tryResolveAuthUserId.mockResolvedValue(null);
  isOwnerSideViewer.mockResolvedValue(false);
});

describe("POST /api/share/:shareId/unlock — brute-force bounds", () => {
  test("an attempt is counted against the link itself, not only the address it came from", async () => {
    await unlock({ ip: "198.51.100.4" });

    // The old key, still there: one address against one link.
    expect(keysFor("unlock:198.51.100.4:")).toEqual([`unlock:198.51.100.4:${SHARE_ID}`]);
    // The bound a fresh proxy cannot escape: the link's own budget, spent by everyone together.
    expect(keysFor("unlock:share:")).toContain(shareKey());
    // And the bound on walking a list of slugs from one host.
    expect(keysFor("unlock:ip:")).toEqual(["unlock:ip:198.51.100.4"]);
  });

  test("the link's budget refuses a guesser whose own address is spotless", async () => {
    exhausted.add(shareKey());

    const res = await unlock({ ip: "198.51.100.77", password: PASSWORD });

    expect(res.status).toBe(429);
    // Refused before the link is read and before scrypt runs — the guess never reaches the hash,
    // so even a correct password arriving mid-attack is turned away rather than handed a cookie.
    expect(resolveShareLink).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a wrong password costs the link's budget more than a right one", async () => {
    // The limiter counts hits, not outcomes, so the ceiling has to stay high enough for a real
    // audience. Charging failures extra is what keeps that ceiling meaningful against a guesser.
    await unlock({ ip: "198.51.100.5", password: "wrong-guess" });
    const spentOnFailure = keysFor("unlock:share:").length;

    limiterCalls.length = 0;
    const ok = await unlock({ ip: "198.51.100.6", password: PASSWORD });
    const spentOnSuccess = keysFor("unlock:share:").length;

    expect(ok.status).toBe(200);
    expect(spentOnFailure).toBeGreaterThan(spentOnSuccess);
  });

  test("the wrong password still answers a plain 401 — the penalty is not a hint", async () => {
    const res = await unlock({ ip: "198.51.100.5", password: "wrong-guess" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid password" });
  });

  test("one address cannot walk a list of guessed slugs", async () => {
    exhausted.add("unlock:ip:198.51.100.9");

    const res = await unlock({ ip: "198.51.100.9", shareId: "srOtherSlug99" });

    expect(res.status).toBe(429);
    expect(resolveShareLink).not.toHaveBeenCalled();
  });

  test("the recipient who has the password still gets in, with their cookie", async () => {
    const res = await unlock({ ip: "203.0.113.20" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sharePasswordEnabled: true });
    expect(res.headers.get("set-cookie") ?? "").toContain(shareAuthCookieName(SHARE_ID));
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  test("a link with no password is unaffected by any of this", async () => {
    resolveShareLink.mockResolvedValue({
      link: protectedLink({ passwordHash: null, passwordSalt: null }),
      doc: { _id: new Types.ObjectId() },
      refusal: null,
    });

    const res = await unlock({ ip: "203.0.113.21" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sharePasswordEnabled: false });
  });
});
