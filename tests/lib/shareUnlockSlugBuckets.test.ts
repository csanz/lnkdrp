/**
 * The share-wide guess budget was escapable by respelling the slug.
 *
 * `POST /api/share/:shareId/unlock` counts every attempt against three buckets, and the one that
 * matters against an attacker with a pool of addresses is the link's own: `unlock:share:<shareId>`.
 * It was keyed on the raw path segment, while `resolveShareLink`/`resolveProjectLink` look the link
 * up by `shareId.trim()`. The two therefore disagreed, and the disagreement was free to exploit:
 * `/api/share/%20<slug>/unlock` verified the password against the *same* link out of a *different*
 * budget, and `String.trim` strips tab, newline, NBSP, the U+2000 block and the BOM in any
 * combination, so the supply of fresh buckets was endless. The ceiling was decorative.
 *
 * The second escape was the opposite shape: a slug long enough to push `ratelimits.key` past
 * Mongo's 1024-byte unique-index limit makes the upsert throw a non-duplicate-key error, and the
 * limiter fails open by design. A caller choosing a multi-kilobyte slug chose to have no limiter at
 * all — all three buckets, not just the link's.
 *
 * These tests assert on the keys the route issues, because the key IS the bound: a bucket the
 * caller can rename is not a bucket.
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

const { limiterCalls, rateLimit, clientIpFromRequest, rateLimitedResponse } = vi.hoisted(() => {
  const limiterCalls: { key: string; limit: number; windowMs: number }[] = [];
  return {
    limiterCalls,
    rateLimit: vi.fn(async (input: { key: string; limit: number; windowMs: number }) => {
      limiterCalls.push({ key: input.key, limit: input.limit, windowMs: input.windowMs });
      return { ok: true, remaining: input.limit - 1, retryAfterSec: 0 };
    }),
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
const { hashSharePassword, shareAuthCookieName } = await import("@/lib/sharePassword");

const SHARE_ID = "srDP4SzZNA5a";
const PASSWORD = "ostrich-9";
const { salt, hash } = hashSharePassword(PASSWORD);

/** Written as codepoints on purpose: each of these is stripped by `trim`, and none is visible. */
const TAB = String.fromCharCode(0x09);
const NEWLINE = String.fromCharCode(0x0a);
const NBSP = String.fromCharCode(0xa0);
const EM_SPACE = String.fromCharCode(0x2003);
const BOM = String.fromCharCode(0xfeff);

const shareKeys = () => limiterCalls.filter((c) => c.key.startsWith("unlock:share:")).map((c) => c.key);

function protectedLink() {
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
  };
}

/**
 * One attempt. `shareId` is the raw path segment — which is the attacker's input, not the link's
 * name, and that is the whole point of these tests.
 */
function unlock(opts: { shareId?: string; password?: string; ip?: string } = {}) {
  const shareId = opts.shareId ?? SHARE_ID;
  return POST(
    new Request(`https://lnkdrp.test/api/share/${encodeURIComponent(shareId)}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}) },
      body: JSON.stringify({ password: opts.password ?? PASSWORD }),
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  limiterCalls.length = 0;
  resolveShareLink.mockResolvedValue({ link: protectedLink(), doc: { _id: new Types.ObjectId() }, refusal: null });
  resolveProjectLink.mockResolvedValue(null);
  tryResolveAuthUserId.mockResolvedValue(null);
  isOwnerSideViewer.mockResolvedValue(false);
});

describe("POST /api/share/:shareId/unlock — the budget follows the link, not the spelling", () => {
  const CANONICAL = `unlock:share:${SHARE_ID}`;

  test.each([
    ["a leading space", ` ${SHARE_ID}`],
    ["a trailing space", `${SHARE_ID} `],
    ["a tab", `${TAB}${SHARE_ID}`],
    ["a newline", `${SHARE_ID}${NEWLINE}`],
    ["a non-breaking space", `${NBSP}${SHARE_ID}`],
    ["an em space", `${SHARE_ID}${EM_SPACE}`],
    ["a byte-order mark", `${BOM}${SHARE_ID}${BOM}`],
    ["several at once", `${TAB}${NBSP} ${SHARE_ID}${NEWLINE}${BOM}`],
  ])("%s spends the same bucket as the bare slug", async (_label, spelling) => {
    await unlock({ shareId: spelling, ip: "198.51.100.4" });

    // The bound an attacker cannot rename. Before the fix each spelling opened a bucket of its own.
    expect(shareKeys()).toEqual([CANONICAL]);
    // And the per-(IP, link) bucket has to travel with it, or the same trick reopens that one.
    expect(limiterCalls.map((c) => c.key)).toContain(`unlock:198.51.100.4:${SHARE_ID}`);
  });

  test("the respelt slug still unlocks, and the cookie is named for the real link", async () => {
    // The escape worked precisely because the respelling is harmless everywhere else: the
    // resolvers trim, so the password is checked against the real link. Keep that true — a fix
    // that 404s a stray space would break nothing an attacker does and might break a mail client
    // that mangles the URL.
    const res = await unlock({ shareId: ` ${SHARE_ID} `, ip: "203.0.113.20" });

    expect(res.status).toBe(200);
    expect(resolveShareLink).toHaveBeenCalledWith(SHARE_ID);
    expect(res.headers.get("set-cookie") ?? "").toContain(shareAuthCookieName(SHARE_ID));
  });

  test("the activity row names the link, not the spelling the guesser used", async () => {
    await unlock({ shareId: `${NBSP}${SHARE_ID}`, ip: "203.0.113.21" });

    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0][0].meta.shareId).toBe(SHARE_ID);
  });

  test("a slug too long to be a slug is refused before any bucket is built from it", async () => {
    // `ratelimits.key` is uniquely indexed; a key past Mongo's 1024-byte index limit throws, and
    // the limiter fails open. So an oversized slug is not a lookup miss to shrug at — it is an
    // unbounded route. It never reaches the limiter or the database.
    const res = await unlock({ shareId: "x".repeat(2048), ip: "198.51.100.9" });

    expect(res.status).toBe(404);
    expect(limiterCalls).toEqual([]);
    expect(resolveShareLink).not.toHaveBeenCalled();
  });

  test("an unknown slug and a refused one answer the same 404", async () => {
    // Uniform on purpose: a holder of an old link must not be able to tell "the sender revoked
    // this" from "this never existed".
    resolveShareLink.mockResolvedValueOnce(null);
    const unknown = await unlock({ shareId: "zzzzzzzzzzzz", ip: "198.51.100.10" });

    resolveShareLink.mockResolvedValueOnce({ link: protectedLink(), doc: {}, refusal: "expired" });
    const revoked = await unlock({ ip: "198.51.100.11" });

    expect([unknown.status, revoked.status]).toEqual([404, 404]);
    expect(await unknown.json()).toEqual(await revoked.json());
  });
});
