/**
 * Signed "accept your invitation" tokens.
 *
 * The invitation email carries a link to `/accept`. The link has to say *who* it is for without
 * trusting whoever is holding it, so it carries a token binding a user id, a purpose and an expiry,
 * signed with HMAC-SHA256 — the same shape as `viewEmailToken.ts`, with its own purpose string so a
 * key minted for one can never verify the other.
 *
 * **The token is not authentication, and that difference matters more here than it does for an
 * unsubscribe link.** What is being recorded at the end of this flow is somebody agreeing to the
 * Terms, and a record that says "whoever opened this email agreed" is worth very little: invitation
 * mail gets forwarded, archived and screenshotted. So the token proves the invitation reached that
 * address, and the sign-in proves who is answering it. `/accept` requires both, and refuses when
 * the signed-in account is not the one the token names.
 *
 * Format: `<payload>.<signature>`, both base64url.
 * - payload: JSON `{ v: 1, p: "waitlist_accept", u: <userId>, e: <expiry epoch ms> }`
 * - signature: HMAC-SHA256 over the payload segment, keyed by a secret derived from the server
 *   secret and the purpose.
 *
 * Server-only (Node crypto).
 */
import crypto from "node:crypto";

export const WAITLIST_ACCEPT_PURPOSE = "waitlist_accept";

/**
 * Default lifetime: 14 days.
 *
 * Long enough that someone who read the mail on a phone and came back at the weekend is not sent a
 * dead link, short enough that a forwarded invitation stops working within a fortnight. Re-running
 * the invite issues a fresh one, so an expired link is a one-command fix rather than a support
 * problem.
 */
export const WAITLIST_ACCEPT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;
/** Generous upper bound; a real token is ~140 chars. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 1024;
const MAX_USER_ID_LENGTH = 128;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const TOKEN_KEY_SALT = "lnkdrp-waitlist-accept";
const TOKEN_KEY_INFO = "waitlist-accept-hkdf:v1";

/** Dev fallback so local envs do not crash. Public by construction; never reached in production. */
const DEV_FALLBACK_SECRET = "dev-lnkdrp-waitlist-accept-secret";

export type AcceptTokenFailure = "malformed" | "bad_signature" | "expired" | "wrong_purpose";

export type VerifyAcceptTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: AcceptTokenFailure; userId?: string };

/**
 * The signing key.
 *
 * `NEXTAUTH_SECRET` is the fallback behind several independent derivations in this codebase, so it
 * is never used raw: HKDF with a salt and info unique to this purpose means a key here cannot
 * verify a realtime ticket, an upload token or an unsubscribe link, and vice versa.
 */
function signingSecret(): string {
  const master = (process.env.NEXTAUTH_SECRET ?? "").trim() || DEV_FALLBACK_SECRET;
  return Buffer.from(crypto.hkdfSync("sha256", master, TOKEN_KEY_SALT, TOKEN_KEY_INFO, 32)).toString("base64url");
}

function sign(payloadSegment: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(payloadSegment).digest("base64url");
}

/** Mint a token for one account. */
export function createAcceptToken(params: { userId: string; ttlMs?: number; now?: number }): string {
  const userId = String(params.userId ?? "").trim();
  if (!userId) throw new Error("createAcceptToken: userId is required");
  const now = typeof params.now === "number" ? params.now : Date.now();
  const ttl = typeof params.ttlMs === "number" && params.ttlMs > 0 ? params.ttlMs : WAITLIST_ACCEPT_TTL_MS;

  const payload = { v: TOKEN_VERSION, p: WAITLIST_ACCEPT_PURPOSE, u: userId, e: now + ttl };
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${segment}.${sign(segment)}`;
}

/**
 * Verify a token.
 *
 * Signature before expiry, and both before the payload is believed: an expired token whose
 * signature does not check out is forged, not stale, and saying "expired" to its holder would tell
 * them their guess was otherwise well-formed.
 */
export function verifyAcceptToken(raw: unknown, opts?: { now?: number }): VerifyAcceptTokenResult {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const segment = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!BASE64URL_RE.test(segment) || !BASE64URL_RE.test(signature)) return { ok: false, reason: "malformed" };

  const expected = sign(segment);
  // Constant-time, and length-checked first because `timingSafeEqual` throws on a length mismatch.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };

  const { v, p, u, e } = parsed as { v?: unknown; p?: unknown; u?: unknown; e?: unknown };
  if (v !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  if (p !== WAITLIST_ACCEPT_PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if (typeof u !== "string" || !u || u.length > MAX_USER_ID_LENGTH) return { ok: false, reason: "malformed" };
  if (typeof e !== "number" || !Number.isFinite(e)) return { ok: false, reason: "malformed" };

  const now = typeof opts?.now === "number" ? opts.now : Date.now();
  // The id is returned with the failure so the page can offer "send me a new link" to the right
  // person rather than a dead end.
  if (now >= e) return { ok: false, reason: "expired", userId: u };

  return { ok: true, userId: u };
}
