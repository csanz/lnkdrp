/**
 * The share-password gate (`shareLinkUnlocked` in `src/lib/share/links.ts`) and the route that had
 * no gate at all: `POST /api/share/:shareId/download-requests`.
 *
 * Every test here is written from the attacker's seat described in the finding — anonymous, holding
 * a forwarded slug for a password-protected link, no account, no cookie. The download-request chain
 * was the way around the password: file a request, let the owner approve it (their mail says
 * nothing about a gate the requester never passed), then claim the PDF.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const {
  resolveShareLink,
  userFindOne,
  requestFindOne,
  requestCreate,
  requestUpdateOne,
  sendTextEmail,
  recordActivity,
  ensurePersonalOrgForUserId,
} = vi.hoisted(() => ({
  resolveShareLink: vi.fn(),
  userFindOne: vi.fn(),
  requestFindOne: vi.fn(),
  requestCreate: vi.fn(),
  requestUpdateOne: vi.fn(),
  sendTextEmail: vi.fn(),
  recordActivity: vi.fn(),
  ensurePersonalOrgForUserId: vi.fn(),
}));

// Partial: the route must run against the *real* gate — a mocked `shareLinkUnlocked` would test
// nothing — while `resolveShareLink` stands in for the database.
vi.mock("@/lib/share/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/share/links")>()),
  resolveShareLink,
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { findOne: userFindOne } }));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({
  ShareDownloadRequestModel: { findOne: requestFindOne, create: requestCreate, updateOne: requestUpdateOne },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId }));
vi.mock("@/lib/email/sendTextEmail", () => ({ sendTextEmail }));
vi.mock("@/lib/email/templates", () => ({
  downloadRequestOwnerEmail: () => ({ subject: "s", text: "t" }),
  downloadRequestReceivedEmail: () => ({ subject: "s", text: "t" }),
}));
vi.mock("@/lib/urls", () => ({
  getPublicSiteBase: () => "https://lnkdrp.test",
  buildPublicShareUrl: (shareId: string) => `https://lnkdrp.test/s/${shareId}`,
  buildPublicProjectUrl: (shareId: string) => `https://lnkdrp.test/p/${shareId}`,
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugWarn: vi.fn(), debugError: vi.fn(), debugEnabled: () => false }));
vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  rateLimit: async () => ({ ok: true }),
  rateLimitedResponse: () => new Response("rate limited", { status: 429 }),
}));

const { POST } = await import("@/app/api/share/[shareId]/download-requests/route");
const { shareLinkPasswordEnabled, shareLinkUnlocked } = await import("@/lib/share/links");
const { shareAuthCookieName, shareAuthCookieValue } = await import("@/lib/sharePassword");

const SHARE_ID = "srDP4SzZNA5a";
const PASSWORD_HASH = "qN0tArEaLhAsH";

/** A link row as `resolveShareLink` hands it back. */
function link(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    shareId: SHARE_ID,
    label: "Sequoia",
    isDefault: true,
    allowDownload: false,
    passwordHash: null as string | null,
    passwordSalt: null as string | null,
    ...overrides,
  };
}

const PROTECTED = { passwordHash: PASSWORD_HASH, passwordSalt: "saltysalt" };

function unlockCookie(shareId = SHARE_ID, sharePasswordHash = PASSWORD_HASH): string {
  return `${shareAuthCookieName(shareId)}=${shareAuthCookieValue({ shareId, sharePasswordHash })}`;
}

function post(opts: { cookie?: string } = {}) {
  return POST(
    new Request(`https://lnkdrp.test/api/share/${SHARE_ID}/download-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({ email: "attacker@gmail.com" }),
    }),
    { params: Promise.resolve({ shareId: SHARE_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestFindOne.mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => null }) }) });
  requestCreate.mockResolvedValue({ _id: new Types.ObjectId() });
  requestUpdateOne.mockResolvedValue({ acknowledged: true });
  userFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ email: "owner@lnkdrp.test" }) }) });
  sendTextEmail.mockResolvedValue(undefined);
  ensurePersonalOrgForUserId.mockResolvedValue({ orgId: new Types.ObjectId() });
});

describe("shareLinkPasswordEnabled", () => {
  test("both halves of the scrypt material, or the link is not protected", () => {
    expect(shareLinkPasswordEnabled({ passwordHash: "h", passwordSalt: "s" })).toBe(true);
    expect(shareLinkPasswordEnabled({ passwordHash: "h", passwordSalt: null })).toBe(false);
    expect(shareLinkPasswordEnabled({ passwordHash: null, passwordSalt: "s" })).toBe(false);
    expect(shareLinkPasswordEnabled({ passwordHash: "", passwordSalt: "" })).toBe(false);
    expect(shareLinkPasswordEnabled(null)).toBe(false);
  });
});

describe("shareLinkUnlocked", () => {
  const req = (cookie?: string) =>
    new Request("https://lnkdrp.test/x", { headers: cookie ? { cookie } : undefined });

  test("a link with no password is always unlocked: callers need no `if`", () => {
    expect(shareLinkUnlocked(req(), SHARE_ID, { passwordHash: null, passwordSalt: null })).toBe(true);
  });

  test("the unlock cookie opens the link it was issued for", () => {
    expect(shareLinkUnlocked(req(unlockCookie()), SHARE_ID, PROTECTED)).toBe(true);
  });

  test("no cookie, a junk cookie, or one minted for another link does not", () => {
    expect(shareLinkUnlocked(req(), SHARE_ID, PROTECTED)).toBe(false);
    expect(shareLinkUnlocked(req(`${shareAuthCookieName(SHARE_ID)}=guess`), SHARE_ID, PROTECTED)).toBe(false);
    // Same document, a different link: one password never unlocks the other audience's URL.
    expect(shareLinkUnlocked(req(unlockCookie("otherSlug1234")), SHARE_ID, PROTECTED)).toBe(false);
  });

  test("changing the password invalidates every cookie already out there", () => {
    const old = unlockCookie();
    expect(shareLinkUnlocked(req(old), SHARE_ID, PROTECTED)).toBe(true);
    expect(shareLinkUnlocked(req(old), SHARE_ID, { passwordHash: "rotatedHash", passwordSalt: "saltysalt" })).toBe(false);
  });

  test("the cookie is found among others the browser sends", () => {
    expect(shareLinkUnlocked(req(`foo=bar; ${unlockCookie()}; next-auth.session-token=zzz`), SHARE_ID, PROTECTED)).toBe(true);
  });
});

describe("POST /api/share/:shareId/download-requests", () => {
  test("a protected link refuses a requester who never entered the password", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: { _id: new Types.ObjectId() }, refusal: null });

    const res = await post();

    expect(res.status).toBe(401);
    // Nothing was created and, above all, the owner was never asked to approve a stranger.
    expect(requestCreate).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("a wrong or foreign unlock cookie is no better than none", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: { _id: new Types.ObjectId() }, refusal: null });

    for (const cookie of [`${shareAuthCookieName(SHARE_ID)}=guess`, unlockCookie("otherSlug1234")]) {
      expect((await post({ cookie })).status).toBe(401);
    }
    expect(requestCreate).not.toHaveBeenCalled();
  });

  test("the refusal comes before the link's download setting is disclosed", async () => {
    // `allowDownload: true` used to answer `download_already_enabled` — a fact about the link, told
    // to someone who had not passed its password.
    resolveShareLink.mockResolvedValue({
      link: link({ ...PROTECTED, allowDownload: true }),
      doc: { _id: new Types.ObjectId() },
      refusal: null,
    });

    const res = await post();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("a recipient who did enter the password can still ask", async () => {
    resolveShareLink.mockResolvedValue({
      link: link(PROTECTED),
      doc: { _id: new Types.ObjectId(), userId: new Types.ObjectId(), orgId: new Types.ObjectId(), title: "USAVX MEMO" },
      refusal: null,
    });

    const res = await post({ cookie: unlockCookie() });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kind: "created" });
    expect(requestCreate).toHaveBeenCalledTimes(1);
  });

  test("a link with no password is unchanged: no cookie needed", async () => {
    resolveShareLink.mockResolvedValue({
      link: link(),
      doc: { _id: new Types.ObjectId(), userId: new Types.ObjectId(), orgId: new Types.ObjectId(), title: "USAVX MEMO" },
      refusal: null,
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(requestCreate).toHaveBeenCalledTimes(1);
  });
});
