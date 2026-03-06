/**
 * Cryptographically secure Base62 string generation.
 *
 * Used to mint stable share slugs without leaking sequential patterns.
 */
import crypto from "node:crypto";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generates a Base62 string using cryptographic randomness.
 *
 * Assumptions: collisions are extremely unlikely but callers still handle dupes defensively.
 */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}

/**
 * Generate a short public identifier for `/s/:shareId`.
 *
 * Notes:
 * - This is NOT a secret; it's a public slug.
 * - Collisions are extremely unlikely, but callers should still handle dupes.
 */
export function newShareId() {
  return randomBase62(12);
}

/**
 * Generate a longer token for secrets (download tokens, request tokens, etc).
 */
export function newSecretToken(length = 24) {
  return randomBase62(length);
}

/**
 * Generate a shareId with retry on collision.
 *
 * @param checkExists - async function that returns true if the ID already exists
 * @param maxRetries - maximum number of retries (default 3)
 */
export async function newShareIdWithRetry(
  checkExists: (id: string) => Promise<boolean>,
  maxRetries = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const id = newShareId();
    if (!(await checkExists(id))) return id;
  }
  // Fallback: use a longer ID to reduce collision probability
  return randomBase62(16);
}
