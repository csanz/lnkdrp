import { describe, expect, test, vi } from "vitest";

// `@/lib/auth` validates provider env at import time; stub the minimum so the module loads.
vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
vi.stubEnv("NEXTAUTH_SECRET", "test-nextauth-secret");
vi.stubEnv("LNKDRP_ORG_INVITE_TOKEN_SECRET", "test-invite-secret");

const { signInviteCookieValue, verifyInviteCookieValue, INVITE_COOKIE_NAME } = await import("@/lib/auth");

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const INVITE_ID = "64b7f0c2a1d3e4f5a6b7c8d9";

describe("auth invite cookie", () => {
  test("keeps the cookie name other routes rely on", () => {
    expect(INVITE_COOKIE_NAME).toBe("ld_invite_ok");
  });

  test("signs `<inviteId>.<expiresUnix>.<hmac>` and verifies it", () => {
    const value = signInviteCookieValue({ inviteId: INVITE_ID, ttlSec: 3600, now: T0 });
    const [id, exp, sig] = value.split(".");
    expect(id).toBe(INVITE_ID);
    expect(Number(exp)).toBe(Math.floor(T0 / 1000) + 3600);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);

    const res = verifyInviteCookieValue(value, T0 + 1000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inviteId).toBe(INVITE_ID);
      expect(res.expiresAt.getTime()).toBe((Math.floor(T0 / 1000) + 3600) * 1000);
    }
  });

  test("rejects expired, tampered, legacy and malformed values", () => {
    const value = signInviteCookieValue({ inviteId: INVITE_ID, ttlSec: 60, now: T0 });
    expect(verifyInviteCookieValue(value, T0 + 61_000).ok).toBe(false);

    const [id, exp, sig] = value.split(".");
    // Extend expiry without re-signing.
    expect(verifyInviteCookieValue(`${id}.${Number(exp) + 999999}.${sig}`, T0).ok).toBe(false);
    // Different invite id.
    expect(verifyInviteCookieValue(`${"0".repeat(24)}.${exp}.${sig}`, T0).ok).toBe(false);
    // Flip one signature nibble.
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifyInviteCookieValue(`${id}.${exp}.${flipped}`, T0).ok).toBe(false);

    expect(verifyInviteCookieValue("1", T0).ok).toBe(false);
    expect(verifyInviteCookieValue("", T0).ok).toBe(false);
    expect(verifyInviteCookieValue(null, T0).ok).toBe(false);
    expect(verifyInviteCookieValue(`${id}.${exp}`, T0).ok).toBe(false);
    expect(verifyInviteCookieValue(`${id}.${exp}.nothex`, T0).ok).toBe(false);
  });

  test("a value signed with a different secret does not verify", () => {
    const value = signInviteCookieValue({ inviteId: INVITE_ID, ttlSec: 60, now: T0 });
    vi.stubEnv("LNKDRP_ORG_INVITE_TOKEN_SECRET", "another-secret");
    try {
      expect(verifyInviteCookieValue(value, T0).ok).toBe(false);
    } finally {
      vi.stubEnv("LNKDRP_ORG_INVITE_TOKEN_SECRET", "test-invite-secret");
    }
    expect(verifyInviteCookieValue(value, T0).ok).toBe(true);
  });
});
