/**
 * `ShareView.viewerIp` is an owner-facing field, and the public PDF proxy filled it from text.
 *
 * `GET /s/:shareId/pdf` attributes a download to an address taken from forwarding headers. Every
 * one of the headers it consults is client-influenced — `cf-connecting-ip` and `true-client-ip` are
 * simply set by a caller reaching the origin directly — and the route's own `normalizeIp` stripped a
 * port and returned whatever was left. So up to 128 characters of a stranger's choosing were stored
 * verbatim and later rendered in the admin share-view tables (`src/lib/admin/shareViews.tsx`).
 *
 * The stats ingest for the same share (`/api/share/[shareId]/stats`) had ended its copy of the
 * helper on `net.isIP` for the whole time; so does `clientIpFromRequest`. This route's copy was the
 * one that never got it.
 *
 * Pinned here: a junk header is skipped rather than stored, the next header along is still honoured,
 * and when nothing validates the row carries no `viewerIp` at all rather than a placeholder. The
 * limiter's own address is a separate question, covered by tests/lib/pdfProxyRateLimit.test.ts —
 * this file only asserts what gets written.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const DOC = new Types.ObjectId();
const LINK = new Types.ObjectId();

/** What a proxy vouches for, versus what a caller can type into a header themselves. */
const PROXY_IP = "203.0.113.9";
const SPOOFED_TEXT = "<script>alert(1)</script>";

const rateLimit = vi.fn(async (_input: unknown) => ({ ok: true, remaining: 29, retryAfterSec: 0 }));
const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const docUpdateOne = vi.fn(async (..._a: unknown[]) => ({ matchedCount: 1 }));
const touchShareLink = vi.fn(async (..._a: unknown[]) => undefined);
const recordActivity = vi.fn(async (..._a: unknown[]) => undefined);

const doc = {
  _id: DOC,
  blobUrl: "https://store123.public.blob.vercel-storage.com/deck.pdf",
  title: "Deck",
  fileName: "deck.pdf",
  orgId: ORG,
  userId: OWNER,
};
const link = { _id: LINK, passwordHash: null, passwordSalt: null, allowDownload: true, label: null, isDefault: true };

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: (...a: unknown[]) => (rateLimit as never as (...x: unknown[]) => unknown)(...a) };
});
vi.mock("@/lib/models/ShareView", () => ({
  // The routes cap the download instants they push; a mocked module without it throws on access.
  DOWNLOAD_INSTANTS_KEPT: 50,
  ShareViewModel: {
    updateOne: (...a: unknown[]) => (shareViewUpdateOne as never as (...x: unknown[]) => unknown)(...a),
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { updateOne: (...a: unknown[]) => (docUpdateOne as never as (...x: unknown[]) => unknown)(...a) },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: unknown[]) => (recordActivity as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: vi.fn(async () => false) }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: vi.fn(async () => null) }));
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: vi.fn(async () => ({ refusal: null, link, doc })),
  touchShareLink: (...a: unknown[]) => (touchShareLink as never as (...x: unknown[]) => unknown)(...a),
}));

/** Let the route's fire-and-forget analytics writes land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function get(headers: Record<string, string>) {
  const { GET } = await import("@/app/s/[shareId]/pdf/route");
  const req = new Request("http://localhost/s/abc123/pdf?download=1&botId=bot-1", { headers });
  const res = await GET(req, { params: Promise.resolve({ shareId: "abc123" }) });
  await settle();
  return res;
}

/** The `$set` the upsert applied to the `ShareView` row. */
function writtenSet(): Record<string, unknown> {
  const update = shareViewUpdateOne.mock.calls[0]?.[1] as { $set?: Record<string, unknown> } | undefined;
  return update?.$set ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true, remaining: 29, retryAfterSec: 0 } as never);
  shareViewUpdateOne.mockResolvedValue({ upsertedCount: 1 } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-length": "4" } })),
  );
});

describe("GET /s/:shareId/pdf — viewerIp", () => {
  test("a header that is not an IP is skipped, not stored", async () => {
    await get({ "cf-connecting-ip": SPOOFED_TEXT, "x-forwarded-for": PROXY_IP });

    const set = writtenSet();
    // The whole finding: this used to be the attacker's string, on the owner's screen.
    expect(set.viewerIp).toBe(PROXY_IP);
    expect(JSON.stringify(set)).not.toContain("script");
  });

  test("when nothing validates, the row carries no viewerIp at all", async () => {
    await get({ "cf-connecting-ip": SPOOFED_TEXT, "x-forwarded-for": "not-an-ip", "x-real-ip": "10.0.0.999" });

    // `10.0.0.999` is the near-miss that a regex-only check waves through.
    expect(writtenSet()).not.toHaveProperty("viewerIp");
    // The download itself is untouched by any of this.
    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
  });

  test("real addresses still attribute, including IPv6 with a port", async () => {
    await get({ "cf-connecting-ip": "[2001:db8::1]:443" });

    expect(writtenSet().viewerIp).toBe("2001:db8::1");
  });

  test("an IPv4 address with a port keeps only the address", async () => {
    await get({ "x-forwarded-for": `${PROXY_IP}:51234, 70.41.3.18` });

    expect(writtenSet().viewerIp).toBe(PROXY_IP);
  });
});
