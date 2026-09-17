/**
 * Signed one-click "turn off view emails" tokens.
 *
 * Every view notification email carries a link that sets the recipient member's
 * `OrgMembership.viewEmailMode` to `off` without a sign-in (the email is often opened on a
 * phone where the user is not signed in; see docs/prds/lnkdrp-view-notifications.md, decision 8).
 * The link therefore carries its own authority: a token binding a membership id, a purpose and
 * an expiry, signed with HMAC-SHA256.
 *
 * Format: `<payload>.<signature>`, both base64url.
 * - payload: JSON `{ v: 1, p: "view_emails_off", m: <membershipId>, e: <expiry epoch ms> }`
 * - signature: HMAC-SHA256 over the payload segment, keyed by a key derived from the server
 *   secret and the purpose string, so a key for another purpose can never verify these tokens.
 *
 * Server-only (Node crypto).
 */
import crypto from "node:crypto";

export const VIEW_EMAILS_OFF_PURPOSE = "view_emails_off";

/** Default token lifetime: 30 days. */
export const VIEW_EMAILS_OFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;
/** Generous upper bound; a real token is ~150 chars. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 1024;
const MAX_MEMBERSHIP_ID_LENGTH = 128;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type ViewEmailsOffTokenFailure = "malformed" | "bad_signature" | "expired" | "wrong_purpose";

export type VerifyViewEmailsOffTokenResult =
  | { ok: true; membershipId: string }
  | { ok: false; reason: ViewEmailsOffTokenFailure; membershipId?: string };

/** Return the server secret (throws in production if missing), mirroring sharePassword.getCookieSecret. */
function getTokenSecret(): string {
  const s = process.env.LNKDRP_NOTIFICATION_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;

  // Dev fallback so local envs don't crash.
  if (process.env.NODE_ENV !== "production") return "dev-lnkdrp-notification-token-secret";

  // In production, do not silently degrade: an unsubscribe link signed with a public key is forgeable.
  throw new Error("Missing LNKDRP_NOTIFICATION_TOKEN_SECRET (or NEXTAUTH_SECRET) for notification tokens");
}

/** Derive the per-purpose signing key from the server secret. */
function signingKey(purpose: string): Buffer {
  return crypto.createHmac("sha256", getTokenSecret()).update(`lnkdrp.notification-token.v1:${purpose}`).digest();
}

/** HMAC-SHA256 of a payload segment under the purpose-bound key. */
function sign(payloadSegment: string, purpose: string): Buffer {
  return crypto.createHmac("sha256", signingKey(purpose)).update(payloadSegment).digest();
}

/** Constant-time equality that never throws: unequal lengths are simply unequal. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** A membership id is a non-empty string of bounded length with no surrounding whitespace. */
function isValidMembershipId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_MEMBERSHIP_ID_LENGTH && v.trim() === v;
}

/** Create a signed token that lets its bearer set this membership's view emails to `off`. */
export function createViewEmailsOffToken(membershipId: string, opts?: { now?: Date; ttlMs?: number }): string {
  const id = String(membershipId ?? "");
  if (!isValidMembershipId(id)) throw new Error("createViewEmailsOffToken: invalid membershipId");
  const now = opts?.now ?? new Date();
  const ttlMs =
    typeof opts?.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : VIEW_EMAILS_OFF_TTL_MS;
  const payload = { v: TOKEN_VERSION, p: VIEW_EMAILS_OFF_PURPOSE, m: id, e: Math.floor(now.getTime() + ttlMs) };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(payloadSegment, VIEW_EMAILS_OFF_PURPOSE).toString("base64url");
  return `${payloadSegment}.${sig}`;
}

/**
 * Verify a view-emails-off token.
 *
 * Order: shape (malformed) -> signature (bad_signature) -> payload (malformed) -> purpose
 * (wrong_purpose) -> expiry (expired, with the membership id since the signature was valid).
 * Never throws for untrusted input; only a missing secret in production throws.
 */
export function verifyViewEmailsOffToken(token: string, opts?: { now?: Date }): VerifyViewEmailsOffTokenResult {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadSegment, sigSegment] = parts as [string, string];
  if (!BASE64URL_RE.test(payloadSegment) || !BASE64URL_RE.test(sigSegment)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(payloadSegment, VIEW_EMAILS_OFF_PURPOSE);
  const given = Buffer.from(sigSegment, "base64url");
  if (!safeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const { v, p, m, e } = payload as { v?: unknown; p?: unknown; m?: unknown; e?: unknown };
  if (v !== TOKEN_VERSION || !isValidMembershipId(m) || typeof e !== "number" || !Number.isFinite(e)) {
    return { ok: false, reason: "malformed" };
  }
  if (p !== VIEW_EMAILS_OFF_PURPOSE) return { ok: false, reason: "wrong_purpose" };

  const nowMs = (opts?.now ?? new Date()).getTime();
  if (nowMs >= e) return { ok: false, reason: "expired", membershipId: m };

  return { ok: true, membershipId: m };
}

/** Absolute one-click off URL for a membership: `<appUrl>/api/notifications/views/off?t=<token>`. */
export function viewEmailsOffUrl(appUrl: string, membershipId: string, opts?: { now?: Date }): string {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  const token = createViewEmailsOffToken(membershipId, { now: opts?.now });
  return `${base}/api/notifications/views/off?t=${encodeURIComponent(token)}`;
}
