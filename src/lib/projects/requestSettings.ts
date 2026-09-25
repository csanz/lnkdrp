/**
 * Small pure pieces of the project docs listing's `request` block, kept out of the route so they
 * can be tested without a database.
 */

/** Hex digests as this app stores them: an anonymous reader's `botIdHash` starts with one. */
const HEX_DIGEST_RE = /^[a-f0-9]{16,128}$/i;

/**
 * The upload path a member may be shown for a request repo, or null.
 *
 * The path carries the repo's upload token, a bearer capability: anyone holding it can upload into
 * the workspace. `viewer` seats could read it out of `GET /api/projects/:slug/docs` and so upload
 * where the app refuses them everything else (code review 2026-09-23). Only a seat that may
 * upload gets the path.
 */
export function requestUploadPathFor(params: { token: string | null | undefined; mayUpload: boolean }): string | null {
  const token = typeof params.token === "string" ? params.token.trim() : "";
  if (!token || !params.mayUpload) return null;
  return `/request/${encodeURIComponent(token)}`;
}

/**
 * The `botIdHash` filter for an anonymous reader's visits, or null when the value is not a hex
 * digest.
 *
 * Rows are keyed `<digest>.<docId>`, so the whole person is reached by an anchored prefix on the
 * digest. The old code stripped non-hex characters and built the regex from what was left, so a
 * value like `"not-a-hash"` became `^` and matched every anonymous visit in the room.
 */
export function botIdHashPrefixFilter(raw: string): { botIdHash: { $regex: string } } | null {
  const digest = raw.trim();
  if (!HEX_DIGEST_RE.test(digest)) return null;
  return { botIdHash: { $regex: `^${digest.toLowerCase()}` } };
}
