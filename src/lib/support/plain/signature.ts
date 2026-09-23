/**
 * Plain request signing (https://www.plain.com/docs/request-signing).
 *
 * Plain signs every request it makes to our customer-card API: `Plain-Request-Signature` is the
 * HMAC-SHA256 of the raw request body, hex-encoded, keyed with the workspace's signing secret
 * (Plain → Settings → Request Signing). The secret lives in `PLAIN_REQUEST_SIGNING_SECRET`.
 *
 * Fail-closed: with no secret configured every request is refused, in every environment. The
 * endpoint hands out a customer's plan, credits, usage and recent errors to whoever can call it,
 * so "no secret yet" must mean "nobody gets in", not "everybody does". Local testing sets the
 * variable to whatever it signs with.
 *
 * The body must be verified as received (the raw string), never re-serialised from the parsed
 * object: key order and whitespace would drift and the digest would never match.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PLAIN_SIGNATURE_HEADER = "plain-request-signature";

/** The signing secret from the environment, trimmed, or null when unset. */
export function configuredPlainSigningSecret(): string | null {
  const v = (process.env.PLAIN_REQUEST_SIGNING_SECRET ?? "").trim();
  return v || null;
}

/** Hex HMAC-SHA256 of the raw body, exactly what Plain puts in the header. */
export function signPlainBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time comparison of the header against the expected digest. */
export function verifyPlainSignature(rawBody: string, header: string | null, secret: string): boolean {
  const provided = (header ?? "").trim().toLowerCase();
  if (!provided) return false;
  const expected = signPlainBody(rawBody, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
