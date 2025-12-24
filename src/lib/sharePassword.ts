import crypto from "node:crypto";

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const ENC_IV_BYTES = 12;

export function shareAuthCookieName(shareId: string) {
  return `lnkdrp_share_auth_${shareId}`;
}

function getCookieSecret(): string {
  // Prefer a dedicated secret, but fall back to NEXTAUTH_SECRET when available.
  const s = process.env.LNKDRP_SHARE_PASSWORD_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;

  // Dev fallback so local envs don't crash.
  if (process.env.NODE_ENV !== "production") return "dev-lnkrdp-share-password-secret";

  // In production, do not silently degrade.
  throw new Error(
    "Missing LNKDRP_SHARE_PASSWORD_SECRET (or NEXTAUTH_SECRET) for share password cookies",
  );
}

function getEncryptionKey(): Buffer {
  const secret = getCookieSecret();
  // Derive a stable 32-byte key.
  return crypto.createHash("sha256").update(secret).digest();
}

export function hashSharePassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(SALT_BYTES).toString("base64url");
  const key = crypto.scryptSync(password, salt, KEY_BYTES);
  return { salt, hash: key.toString("base64url") };
}

export function verifySharePassword(args: {
  password: string;
  salt: string | null | undefined;
  hash: string | null | undefined;
}): boolean {
  const salt = typeof args.salt === "string" ? args.salt : "";
  const hash = typeof args.hash === "string" ? args.hash : "";
  if (!salt || !hash) return false;

  const key = crypto.scryptSync(args.password, salt, KEY_BYTES).toString("base64url");
  // Constant-time compare.
  const a = Buffer.from(key);
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Produce a per-shareId auth cookie value.
 *
 * Important: This is NOT the password hash; it's an HMAC over it so it can be used
 * as a bearer token without exposing DB material.
 */
export function shareAuthCookieValue(args: { shareId: string; sharePasswordHash: string }) {
  const secret = getCookieSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(`${args.shareId}:${args.sharePasswordHash}`)
    .digest("base64url");
}

export function encryptSharePassword(password: string): { enc: string; iv: string; tag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(ENC_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: enc.toString("base64url"), iv: iv.toString("base64url"), tag: tag.toString("base64url") };
}

export function decryptSharePassword(args: {
  enc: string | null | undefined;
  iv: string | null | undefined;
  tag: string | null | undefined;
}): string | null {
  if (!args.enc || !args.iv || !args.tag) return null;
  if (typeof args.enc !== "string" || typeof args.iv !== "string" || typeof args.tag !== "string") return null;

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(args.iv, "base64url");
    const tag = Buffer.from(args.tag, "base64url");
    const enc = Buffer.from(args.enc, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}



