/**
 * `NEXTAUTH_SECRET` is the fallback behind five independent keys in this codebase — session
 * cookies, the AES key over every share password at rest, the AES key over org invite tokens, the
 * view-notification/unsubscribe HMAC and the internal upload-processing HMAC. Each module that
 * took it verbatim turned "knows one narrow key" into "knows the master secret".
 *
 * `src/lib/realtime/ticket.ts` was fixed first (it is pinned in `tests/lib/ticketSecretAndSearch.test.ts`).
 * This file pins the same shape on the two modules that followed:
 *
 * - `src/lib/uploads/internalProcess.ts` — five-minute tokens, nothing at rest, straight swap.
 * - `src/lib/notifications/viewEmailToken.ts` — the careful one. These tokens live in already-sent
 *   emails for 30 days, so the fix derives the new signing secret AND keeps verifying tokens signed
 *   with the old raw-master secret. Unsubscribe links already in a mailbox must keep working: the
 *   recipient is asking us to stop emailing them, and "that link is not valid" is the wrong answer
 *   to give them for a server-side hygiene change.
 *
 * `src/lib/sharePassword.ts` is deliberately NOT part of this: rotating that key makes every stored
 * share password undecryptable and needs a real re-encryption migration.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import crypto from "node:crypto";

const { signInternalProcessToken, verifyInternalProcessToken } = await import("@/lib/uploads/internalProcess");
const { createViewEmailsOffToken, verifyViewEmailsOffToken, VIEW_EMAILS_OFF_PURPOSE } = await import(
  "@/lib/notifications/viewEmailToken"
);

const MASTER = "master-nextauth-secret-value-1234567890";
const DEDICATED = "a-distinct-notification-secret-0987654321";
const UPLOAD_ID = "65f0c0ffee0123456789abcd";
const MEMBERSHIP = "65f0c0ffee0123456789abce";
const NOW = new Date("2026-09-20T12:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

// --- The internal upload-processing HMAC ---------------------------------------------------------

/** How `internalProcess.mac` looked before the fix: the master secret used directly as the key. */
function legacyProcessMac(uploadId: string, ts: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`process:${uploadId}:${ts}`).digest("base64url");
}

describe("internal upload-processing tokens", () => {
  test("round trip still works on a deployment that only has NEXTAUTH_SECRET", () => {
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    vi.stubEnv("CRON_SECRET", "");
    const now = NOW.getTime();
    expect(verifyInternalProcessToken(UPLOAD_ID, signInternalProcessToken(UPLOAD_ID, now), now)).toBe(true);
  });

  test("holding NEXTAUTH_SECRET is no longer the same thing as being able to mint a process token", () => {
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    vi.stubEnv("CRON_SECRET", "");
    const now = NOW.getTime();
    // A token forged exactly the way the old code signed them.
    const forged = `${now}.${legacyProcessMac(UPLOAD_ID, now, MASTER)}`;
    expect(verifyInternalProcessToken(UPLOAD_ID, forged, now)).toBe(false);
  });

  test("CRON_SECRET is derived too — it travels in an Authorization header and lands in logs", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("CRON_SECRET", MASTER);
    const now = NOW.getTime();
    expect(verifyInternalProcessToken(UPLOAD_ID, signInternalProcessToken(UPLOAD_ID, now), now)).toBe(true);
    expect(verifyInternalProcessToken(UPLOAD_ID, `${now}.${legacyProcessMac(UPLOAD_ID, now, MASTER)}`, now)).toBe(false);
  });

  test("the derived key is stable across calls, and still bound to the upload id", () => {
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    vi.stubEnv("CRON_SECRET", "");
    const now = NOW.getTime();
    const token = signInternalProcessToken(UPLOAD_ID, now);
    expect(signInternalProcessToken(UPLOAD_ID, now)).toBe(token);
    expect(verifyInternalProcessToken("65f0c0ffee0123456789abcf", token, now)).toBe(false);
  });

  test("no secret at all still refuses rather than signing with an empty key", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    expect(() => signInternalProcessToken(UPLOAD_ID, NOW.getTime())).toThrow(/NEXTAUTH_SECRET/);
    // Verification degrades instead of throwing: an unverifiable token is simply not ours.
    expect(verifyInternalProcessToken(UPLOAD_ID, `${NOW.getTime()}.whatever`, NOW.getTime())).toBe(false);
  });
});

// --- View-notification / unsubscribe tokens ------------------------------------------------------

/** How `viewEmailToken` signed before the fix: purpose-bound key, but keyed by the RAW secret. */
function legacyViewEmailsOffToken(membershipId: string, secret: string, opts: { now: Date; ttlMs: number }): string {
  const payload = { v: 1, p: VIEW_EMAILS_OFF_PURPOSE, m: membershipId, e: Math.floor(opts.now.getTime() + opts.ttlMs) };
  const seg = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = crypto.createHmac("sha256", secret).update(`lnkdrp.notification-token.v1:${VIEW_EMAILS_OFF_PURPOSE}`).digest();
  return `${seg}.${crypto.createHmac("sha256", key).update(seg).digest("base64url")}`;
}

describe("view-emails-off tokens", () => {
  test("a fresh token is no longer signed under the raw master secret", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: true, membershipId: MEMBERSHIP });

    // The signature a holder of NEXTAUTH_SECRET would have produced is not this one.
    const asMasterWouldSign = legacyViewEmailsOffToken(MEMBERSHIP, MASTER, { now: NOW, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(token.split(".")[1]).not.toBe(asMasterWouldSign.split(".")[1]);
  });

  test("an unsubscribe link already sitting in a mailbox still works (dual-read)", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const alreadySent = legacyViewEmailsOffToken(MEMBERSHIP, MASTER, { now: NOW, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(verifyViewEmailsOffToken(alreadySent, { now: NOW })).toEqual({ ok: true, membershipId: MEMBERSHIP });
  });

  test("the legacy read is still a signature check, not an open door", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const someoneElsesSecret = legacyViewEmailsOffToken(MEMBERSHIP, "not-this-servers-secret", {
      now: NOW,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(verifyViewEmailsOffToken(someoneElsesSecret, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("an expired legacy link is still expired — the fallback does not extend its life", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const old = legacyViewEmailsOffToken(MEMBERSHIP, MASTER, { now: NOW, ttlMs: 1000 });
    expect(verifyViewEmailsOffToken(old, { now: new Date(NOW.getTime() + 2000) })).toEqual({
      ok: false,
      reason: "expired",
      membershipId: MEMBERSHIP,
    });
  });

  test("a secret set for this purpose is used exactly as configured — nothing rotates, no fallback", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", DEDICATED);
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    const asConfigured = legacyViewEmailsOffToken(MEMBERSHIP, DEDICATED, { now: NOW, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(token.split(".")[1]).toBe(asConfigured.split(".")[1]);
    // And a token signed with the master secret is not accepted on such a deployment.
    const masterSigned = legacyViewEmailsOffToken(MEMBERSHIP, MASTER, { now: NOW, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(verifyViewEmailsOffToken(masterSigned, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("LNKDRP_NOTIFICATION_TOKEN_SECRET set to a copy of NEXTAUTH_SECRET is the same mistake, and is derived", () => {
    vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", MASTER);
    vi.stubEnv("NEXTAUTH_SECRET", MASTER);
    const token = createViewEmailsOffToken(MEMBERSHIP, { now: NOW });
    const asMasterWouldSign = legacyViewEmailsOffToken(MEMBERSHIP, MASTER, { now: NOW, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(token.split(".")[1]).not.toBe(asMasterWouldSign.split(".")[1]);
    // Still dual-read, because links sent by that deployment were signed with the copy.
    expect(verifyViewEmailsOffToken(asMasterWouldSign, { now: NOW })).toEqual({ ok: true, membershipId: MEMBERSHIP });
  });
});
