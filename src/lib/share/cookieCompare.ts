/**
 * The share-auth cookie compare, in one place and in constant time.
 *
 * The cookie a recipient carries after typing a link's password is a keyed digest of the link's
 * password hash (`shareAuthCookieValue`). It is a bearer secret, and it was compared with `===` in
 * `shareLinkUnlocked` and in eleven inline copies across the share pages and routes. `===` stops
 * at the first differing byte, which is the textbook timing side-channel; not a practical break of
 * a 64-hex-character digest over the network, but the same class of bug the password verifier and
 * the upload-secret check were already fixed for, and one helper is easier to keep right than
 * twelve comparisons.
 *
 * No Mongo, no Next imports: this file is safe to test and to import from anything.
 */
import crypto from "node:crypto";

/**
 * True when `presented` (the cookie the request carried, or nothing) equals `expected`, compared
 * in constant time. Length is checked first because `timingSafeEqual` throws on a mismatch; the
 * length of a digest is not a secret.
 */
export function shareAuthCookieMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
