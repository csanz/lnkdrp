/**
 * The Slack webhook URL at rest, and the signature on the OAuth `state`.
 *
 * Both keys are derived with HKDF from one master secret: `LNKDRP_SLACK_SECRET` when set,
 * otherwise `NEXTAUTH_SECRET`, the same per-purpose convention as the notification tokens and the
 * realtime tickets. Deriving rather than reusing means a leaked Slack key says nothing about
 * sessions, and the two purposes here (encrypting, signing) get different keys from the same root.
 *
 * A webhook URL is a bearer credential: anyone holding it can post into the customer's channel.
 * So it is AES-256-GCM encrypted before it touches the database and decrypted only at the moment
 * of posting. It is never logged and never serialised into an API response.
 */
import crypto from "node:crypto";

const SALT = "lnkdrp-slack";
const ENC_INFO = "slack-webhook-aes:v1";
const SIGN_INFO = "slack-oauth-state-hmac:v1";
const IV_BYTES = 12;

/** Dev fallback so a local env without either secret still runs; never reached in production. */
const DEV_FALLBACK_SECRET = "dev-lnkdrp-slack-secret";

function masterSecret(): string {
  const s = (process.env.LNKDRP_SLACK_SECRET || process.env.NEXTAUTH_SECRET || "").trim();
  if (s) return s;
  if (process.env.NODE_ENV !== "production") return DEV_FALLBACK_SECRET;
  throw new Error("Missing LNKDRP_SLACK_SECRET (or NEXTAUTH_SECRET) for the Slack integration");
}

function derive(info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterSecret(), SALT, info, 32));
}

/** `enc.iv.tag`, each base64url, so one string column holds the whole ciphertext. */
export function encryptSlackSecret(plain: string): string {
  const key = derive(ENC_INFO);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${enc.toString("base64url")}.${iv.toString("base64url")}.${tag.toString("base64url")}`;
}

/** The plaintext, or `null` for anything that was not produced by `encryptSlackSecret` with this key. */
export function decryptSlackSecret(packed: string | null | undefined): string | null {
  if (!packed || typeof packed !== "string") return null;
  const parts = packed.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = derive(ENC_INFO);
    const [enc, iv, tag] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** HMAC-SHA256 over `payload`, base64url. Used for the OAuth `state`. */
export function signSlackPayload(payload: string): string {
  return crypto.createHmac("sha256", derive(SIGN_INFO)).update(payload).digest("base64url");
}

/** Constant-time comparison of a signature against `payload`. */
export function verifySlackSignature(payload: string, signature: string): boolean {
  const expected = signSlackPayload(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
