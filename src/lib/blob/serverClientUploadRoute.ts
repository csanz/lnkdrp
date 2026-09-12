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

import { DOC_BLOB_PREFIX, ORG_AVATAR_PREFIX } from "./clientUpload";

/**
 * Content types we allow for the client upload route.
 * - `image/*` covers jpeg/png/webp/etc.
 * - `application/pdf` covers PDFs.
 */
export const CLIENT_UPLOAD_ALLOWED_CONTENT_TYPES = [
  "image/*",
  "application/pdf",
] as const;

/**
 * Max file size for client uploads (client uploads can support large files,
 * but we keep this reasonable so accidental huge uploads don't happen).
 */
export const CLIENT_UPLOAD_MAX_SIZE_BYTES = 250 * 1024 * 1024; // 250MB

/**
 * Guardrail: only allow destinations under our known production prefixes.
 *
 * Note: this is a coarse gate; ownership checks per pathname happen in the route handler.
 */
export function assertAllowedTestPathname(pathname: string): void {
  const allowed = [DOC_BLOB_PREFIX, ORG_AVATAR_PREFIX];
  if (!allowed.some((p) => pathname.startsWith(p))) {
    throw new Error(
      `Invalid pathname. Must start with one of: ${allowed.join(", ")}. Got: ${pathname}`,
    );
  }
}

const OBJECT_ID_RX = /^[0-9a-fA-F]{24}$/;

/**
 * Parse a doc-upload blob pathname of the form `docs/{docId}/uploads/{uploadId}/...`.
 *
 * Returns `null` for anything else (including paths with traversal segments or missing tail).
 */
export function parseDocUploadBlobPathname(pathname: string): { docId: string; uploadId: string } | null {
  const p = (pathname ?? "").replace(/^\/+/, "");
  if (!p.startsWith(DOC_BLOB_PREFIX)) return null;
  const rest = p.slice(DOC_BLOB_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length < 4) return null;
  const [docId, uploadsSeg, uploadId, ...tail] = parts;
  if (uploadsSeg !== "uploads") return null;
  if (!OBJECT_ID_RX.test(docId) || !OBJECT_ID_RX.test(uploadId)) return null;
  if (!tail.length || tail.some((s) => !s || s === "." || s === "..")) return null;
  return { docId, uploadId };
}

/**
 * Parse an org-avatar blob pathname of the form `org-avatars/{orgId}/...`.
 */
export function parseOrgAvatarBlobPathname(pathname: string): { orgId: string } | null {
  const p = (pathname ?? "").replace(/^\/+/, "");
  if (!p.startsWith(ORG_AVATAR_PREFIX)) return null;
  const parts = p.slice(ORG_AVATAR_PREFIX.length).split("/");
  if (parts.length < 2) return null;
  const [orgId, ...tail] = parts;
  if (!OBJECT_ID_RX.test(orgId)) return null;
  if (!tail.length || tail.some((s) => !s || s === "." || s === "..")) return null;
  return { orgId };
}

const VERCEL_BLOB_PUBLIC_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Derive our store host from `BLOB_READ_WRITE_TOKEN` (`vercel_blob_rw_<storeId>_<secret>`):
 * the public host of a store is `<storeId>.public.blob.vercel-storage.com`.
 */
function blobStoreHostFromToken(): string | null {
  const token = (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim();
  if (!token.startsWith("vercel_blob_rw_")) return null;
  const [, , , storeId = ""] = token.split("_");
  const id = storeId.trim().toLowerCase();
  if (!id || !/^[a-z0-9]+$/.test(id)) return null;
  return `${id}${VERCEL_BLOB_PUBLIC_HOST_SUFFIX}`;
}

/**
 * Return the hostname of our Blob store, or `null` when it cannot be determined.
 *
 * Prefers `BLOB_BASE_URL` (explicit), then the store id embedded in `BLOB_READ_WRITE_TOKEN`.
 */
export function getBlobStoreHost(): string | null {
  const raw = (process.env.BLOB_BASE_URL ?? "").trim().replace(/^"|"$/g, "");
  if (raw) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      // fall through to the token-derived host
    }
  }
  return blobStoreHostFromToken();
}

/**
 * Return whether `hostname` is our Blob store host.
 *
 * Exact match against the configured/derived store host (see `getBlobStoreHost`). When neither
 * `BLOB_BASE_URL` nor `BLOB_READ_WRITE_TOKEN` identifies the store, production **fails closed**
 * (any store on `*.public.blob.vercel-storage.com` would otherwise be accepted, letting a caller
 * attach a file from their own store); outside production the host pattern is accepted so local
 * setups without a token keep working.
 */
export function isBlobStoreHost(hostname: string): boolean {
  const h = (hostname ?? "").toLowerCase();
  if (!h) return false;
  const configured = getBlobStoreHost();
  if (configured) return h === configured;
  if (process.env.NODE_ENV === "production") return false;
  return h.endsWith(VERCEL_BLOB_PUBLIC_HOST_SUFFIX);
}

/**
 * Validate that a client-reported blob URL points at *our* store and lives under the
 * given upload's folder (`docs/{docId}/uploads/{uploadId}/`).
 */
export function isBlobUrlForUpload(url: string, params: { docId: string; uploadId: string }): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!isBlobStoreHost(u.hostname)) return false;
  return isBlobPathnameForUpload(u.pathname, params);
}

/**
 * Validate that a blob pathname lives under the given upload's folder.
 */
export function isBlobPathnameForUpload(pathname: string, params: { docId: string; uploadId: string }): boolean {
  let decoded = pathname ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return false;
  }
  const parsed = parseDocUploadBlobPathname(decoded);
  return Boolean(parsed && parsed.docId === params.docId && parsed.uploadId === params.uploadId);
}
