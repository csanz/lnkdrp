import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import crypto from "node:crypto";

const SECRET = "test-notification-token-secret";

const {
  createViewEmailsOffToken,
  verifyViewEmailsOffToken,
  viewEmailsOffUrl,
  VIEW_EMAILS_OFF_PURPOSE,
  VIEW_EMAILS_OFF_TTL_MS,
} = await import("@/lib/notifications/viewEmailToken");

const MEMBERSHIP = "65f0c0ffee0123456789abcd";
const NOW = new Date("2026-09-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Sign an arbitrary payload exactly as the module does, to forge well-signed but unusual tokens. */
function signPayload(payload: unknown, secret = SECRET, purposeForKey = VIEW_EMAILS_OFF_PURPOSE): string {
  const seg = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = crypto.createHmac("sha256", secret).update(`lnkdrp.notification-token.v1:${purposeForKey}`).digest();
  const sig = crypto.createHmac("sha256", key).update(seg).digest("base64url");
  return `${seg}.${sig}`;
}

describe("viewEmailToken", () => {
  beforeEach(() => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("round trip returns the membership id", () => {
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: true, membershipId: MEMBERSHIP });
    expect(verifyViewEmailsOffToken(token, { now: new Date(NOW.getTime() + 29 * DAY) })).toEqual({
      ok: true,
      membershipId: MEMBERSHIP,
    });
  });

  test("payload carries membership id, purpose and a 30-day expiry by default", () => {
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ m: MEMBERSHIP, p: "view_emails_off", e: NOW.getTime() + VIEW_EMAILS_OFF_TTL_MS });
    expect(VIEW_EMAILS_OFF_TTL_MS).toBe(30 * DAY);
  });

  test("a tampered payload or signature is bad_signature", () => {
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    const [seg, sig] = token.split(".") as [string, string];

    const otherPayload = Buffer.from(
      JSON.stringify({ v: 1, p: "view_emails_off", m: "65f0c0ffee0123456789ffff", e: NOW.getTime() + DAY }),
    ).toString("base64url");
    expect(verifyViewEmailsOffToken(`${otherPayload}.${sig}`, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });

    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyViewEmailsOffToken(`${seg}.${flipped}`, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a token signed with a different secret is bad_signature and reveals no membership", () => {
    const forged = signPayload({ v: 1, p: "view_emails_off", m: MEMBERSHIP, e: NOW.getTime() + DAY }, "another-secret");
    const res = verifyViewEmailsOffToken(forged, { now: NOW });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("the signing key is bound to the purpose", () => {
    // Same secret, key derived for another purpose: the signature must not verify.
    const otherKey = signPayload({ v: 1, p: "view_emails_off", m: MEMBERSHIP, e: NOW.getTime() + DAY }, SECRET, "doc_update_emails_off");
    expect(verifyViewEmailsOffToken(otherKey, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a correctly signed payload with another purpose is wrong_purpose", () => {
    const token = signPayload({ v: 1, p: "doc_update_emails_off", m: MEMBERSHIP, e: NOW.getTime() + DAY });
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: false, reason: "wrong_purpose" });
  });

  test("expiry reports expired with the membership id", () => {
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW, ttlMs: 60_000 });
    expect(verifyViewEmailsOffToken(token, { now: new Date(NOW.getTime() + 59_999) }).ok).toBe(true);
    expect(verifyViewEmailsOffToken(token, { now: new Date(NOW.getTime() + 60_000) })).toEqual({
      ok: false,
      reason: "expired",
      membershipId: MEMBERSHIP,
    });

    const month = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    expect(verifyViewEmailsOffToken(month, { now: new Date(NOW.getTime() + 31 * DAY) })).toEqual({
      ok: false,
      reason: "expired",
      membershipId: MEMBERSHIP,
    });
  });

  test("malformed input never throws", () => {
    const cases: unknown[] = [
      "",
      "abc",
      "a.b.c",
      ".",
      "abc.",
      ".abc",
      "a b.c",
      "abc.d+f/",
      "%%%.%%%",
      "x".repeat(5000) + ".y",
      null,
      undefined,
      123,
      {},
    ];
    for (const c of cases) {
      const res = verifyViewEmailsOffToken(c as string, { now: NOW });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["malformed", "bad_signature"]).toContain(res.reason);
      if (!res.ok) expect(res.membershipId).toBeUndefined();
    }
    expect(verifyViewEmailsOffToken("", { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyViewEmailsOffToken("a.b.c", { now: NOW })).toEqual({ ok: false, reason: "malformed" });
  });

  test("a correctly signed but structurally invalid payload is malformed", () => {
    const notJson = (() => {
      const seg = Buffer.from("not json", "utf8").toString("base64url");
      const key = crypto.createHmac("sha256", SECRET).update(`lnkdrp.notification-token.v1:${VIEW_EMAILS_OFF_PURPOSE}`).digest();
      return `${seg}.${crypto.createHmac("sha256", key).update(seg).digest("base64url")}`;
    })();
    expect(verifyViewEmailsOffToken(notJson, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyViewEmailsOffToken(signPayload([1, 2]), { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyViewEmailsOffToken(signPayload({ v: 1, p: "view_emails_off", m: "", e: NOW.getTime() + DAY }), { now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyViewEmailsOffToken(signPayload({ v: 1, p: "view_emails_off", m: MEMBERSHIP, e: "soon" }), { now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyViewEmailsOffToken(signPayload({ v: 2, p: "view_emails_off", m: MEMBERSHIP, e: NOW.getTime() + DAY }), { now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("constant-time compare does not throw on signature length mismatch", () => {
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    const [seg, sig] = token.split(".") as [string, string];
    expect(() => verifyViewEmailsOffToken(`${seg}.${sig.slice(0, 10)}`, { now: NOW })).not.toThrow();
    expect(verifyViewEmailsOffToken(`${seg}.${sig.slice(0, 10)}`, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyViewEmailsOffToken(`${seg}.${sig}${sig}`, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyViewEmailsOffToken(`${seg}.A`, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("create rejects an empty membership id", () => {
    expect(() => createViewEmailsOffToken("")).toThrow();
  });

  test("viewEmailsOffUrl builds the off route URL with a verifiable token", () => {
    const url = viewEmailsOffUrl("https://lnkdrp.com/", MEMBERSHIP, { now: NOW });
    expect(url.startsWith("https://lnkdrp.com/api/notifications/views/off?t=")).toBe(true);
    const t = new URL(url).searchParams.get("t")!;
    expect(verifyViewEmailsOffToken(t, { now: NOW })).toEqual({ ok: true, membershipId: MEMBERSHIP });
  });

  test("falls back to NEXTAUTH_SECRET, and tokens from one secret fail under another", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "nextauth-secret");
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    expect(verifyViewEmailsOffToken(token, { now: NOW }).ok).toBe(true);
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", SECRET);
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a missing secret throws in production and uses a dev fallback otherwise", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    expect(verifyViewEmailsOffToken(token, { now: NOW }).ok).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createViewEmailsOffToken(MEMBERSHIP, { now: NOW })).toThrow(/LNKDRP_NOTIFICATION_TOKEN_SECRET/);
  });
});
