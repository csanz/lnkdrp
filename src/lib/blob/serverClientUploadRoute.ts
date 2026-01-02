/**
 * Server-side configuration + validation for Vercel Blob client uploads.
 *
 * The browser uploads directly to Vercel Blob.
 * Our server route only:
 * - mints a short-lived client token (scoped + constrained)
 * - optionally receives an "upload completed" callback from Vercel
 *
 * Docs: https://vercel.com/docs/vercel-blob/client-upload
 */

import { DOC_BLOB_PREFIX, ORG_AVATAR_PREFIX, TEST_BLOB_PREFIX } from "./clientUpload";

/**
 * Content types we allow for the demo/test upload route.
 * - `image/*` covers jpeg/png/webp/etc.
 * - `application/pdf` covers PDFs.
 */
export const CLIENT_UPLOAD_ALLOWED_CONTENT_TYPES = [
  "image/*",
  "application/pdf",
] as const;

/**
 * Max file size for demo/test uploads (client uploads can support large files,
 * but we keep this reasonable so accidental huge uploads don't happen).
 */
export const CLIENT_UPLOAD_MAX_SIZE_BYTES = 250 * 1024 * 1024; // 250MB

/**
 * Guardrail: only allow destinations under our test prefix.
 */
export function assertAllowedTestPathname(pathname: string): void {
  const allowed = [TEST_BLOB_PREFIX, DOC_BLOB_PREFIX, ORG_AVATAR_PREFIX];
  if (!allowed.some((p) => pathname.startsWith(p))) {
    throw new Error(
      `Invalid pathname. Must start with one of: ${allowed.join(", ")}. Got: ${pathname}`,
    );
  }
}
