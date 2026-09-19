/**
 * Signed token for "yes, that is my address" on a share link.
 *
 * A reader who introduces themselves types a name and an email, and nothing checks the address:
 * the owner sees a name they cannot rely on, and a reader can be impersonated by anyone who has
 * the link. This token is the other half — mailed to the address itself, it proves the reader can
 * read that inbox.
 *
 * Deliberately NOT a gate (owner, 2026-09-18): the introduction works, the document opens, and the
 * reading is attributed the moment they introduce themselves. Verification only upgrades a claimed
 * address to a verified one; a reader who ignores the email loses nothing. The gated variant — a
 * link that refuses to open until the address is verified — is a separate, opt-in feature
 * (metis mt_Ef6isZoEr5).
 *
 * Shape and signing follow `src/lib/notifications/viewEmailToken.ts`: `<payload>.<sig>`, base64url,
 * HMAC-SHA256 under a purpose-bound key, constant-time comparison, expiry inside the payload.
 */
import crypto from "node:crypto";

const TOKEN_VERSION = 1;
const PURPOSE = "share-viewer-email" as const;
/** A day: long enough for someone who reads a deck now and their inbox tonight. */
export const VIEWER_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_FIELD_LENGTH = 320;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type ViewerEmailTokenPayload = {
  /** The link the introduction was made on (`/s/:shareId` or `/p/:shareId`). */
  shareId: string;
  /** The reader's browser-scoped id, so a verified address attaches to that reader's rows. */
  viewerKey: string;
  /** The address being proved, already normalised by the caller. */
  email: string;
};

export type VerifyViewerEmailTokenResult =
  | ({ ok: true } & ViewerEmailTokenPayload)
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" };

/** The server secret; never silently degrades in production, where a forgeable token is a lie. */
function getTokenSecret(): string {
  const s = process.env.LNKDRP_NOTIFICATION_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;
  if (process.env.NODE_ENV !== "production") return "dev-lnkdrp-notification-token-secret";
  throw new Error("Missing LNKDRP_NOTIFICATION_TOKEN_SECRET (or NEXTAUTH_SECRET) for viewer email tokens");
}

function sign(payloadSegment: string): Buffer {
  const key = crypto.createHmac("sha256", getTokenSecret()).update(`lnkdrp.notification-token.v1:${PURPOSE}`).digest();
  return crypto.createHmac("sha256", key).update(payloadSegment).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isField(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD_LENGTH && v.trim() === v;
}

/** Sign "this reader, on this link, claims this address". */
export function createViewerEmailToken(
  input: ViewerEmailTokenPayload,
  opts?: { now?: Date; ttlMs?: number },
): string {
  if (!isField(input.shareId) || !isField(input.viewerKey) || !isField(input.email)) {
    throw new Error("createViewerEmailToken: shareId, viewerKey and email are required");
  }
  const nowMs = (opts?.now ?? new Date()).getTime();
  const ttl = typeof opts?.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : VIEWER_EMAIL_TOKEN_TTL_MS;
  const payload = { v: TOKEN_VERSION, p: PURPOSE, s: input.shareId, k: input.viewerKey, m: input.email, e: nowMs + ttl };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadSegment}.${sign(payloadSegment).toString("base64url")}`;
}

/** Check a token and return what it says, or why it cannot be trusted. */
export function verifyViewerEmailToken(token: string, opts?: { now?: Date }): VerifyViewerEmailTokenResult {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadSegment, sigSegment] = parts as [string, string];
  if (!BASE64URL_RE.test(payloadSegment) || !BASE64URL_RE.test(sigSegment)) return { ok: false, reason: "malformed" };

  if (!safeEqual(Buffer.from(sigSegment, "base64url"), sign(payloadSegment))) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const { v, p, s, k, m, e } = payload as Record<string, unknown>;
  if (v !== TOKEN_VERSION || !isField(s) || !isField(k) || !isField(m) || typeof e !== "number" || !Number.isFinite(e)) {
    return { ok: false, reason: "malformed" };
  }
  if (p !== PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if ((opts?.now ?? new Date()).getTime() >= e) return { ok: false, reason: "expired" };

  return { ok: true, shareId: s, viewerKey: k, email: m };
}

/** The absolute URL mailed to the reader: `<appUrl>/share/verify?t=<token>`. */
export function viewerEmailVerifyUrl(appUrl: string, input: ViewerEmailTokenPayload, opts?: { now?: Date }): string {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  return `${base}/share/verify?t=${encodeURIComponent(createViewerEmailToken(input, opts))}`;
}
