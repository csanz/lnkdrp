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
import { BROWSER_DIRECT_UPLOAD_MAX_BYTES } from "@/lib/limits/uploads";

/**
 * Content types allowed for document uploads (`docs/{docId}/uploads/{uploadId}/...`).
 *
 * Documents are PDF-only for now: the processing pipeline (text extraction, page rendering,
 * AI passes) only understands PDFs, so anything else is rejected at token-mint time.
 */
export const DOC_UPLOAD_ALLOWED_CONTENT_TYPES = ["application/pdf"] as const;

/**
 * Content types allowed for workspace avatar uploads (`org-avatars/{orgId}/...`).
 */
export const AVATAR_UPLOAD_ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * @deprecated Use `allowedContentTypesForPathname(pathname)` so each prefix gets its own
 * allowlist. Kept as the union of both lists for callers that have not migrated yet.
 */
export const CLIENT_UPLOAD_ALLOWED_CONTENT_TYPES = [
  ...DOC_UPLOAD_ALLOWED_CONTENT_TYPES,
  ...AVATAR_UPLOAD_ALLOWED_CONTENT_TYPES,
] as const;

/**
 * The one image the browser may write under `docs/`: the client-rendered first-page preview
 * (`docs/{docId}/uploads/{uploadId}/preview.png`, see `buildDocPreviewPngPathname`).
 */
const DOC_PREVIEW_PNG_SUFFIX = "/preview.png";
export const DOC_PREVIEW_ALLOWED_CONTENT_TYPES = ["image/png"] as const;

/**
 * Return the content-type allowlist for a client upload `pathname`, chosen by its prefix:
 * `docs/` gets the PDF-only document list (except the `preview.png` artifact, which is PNG-only)
 * and `org-avatars/` gets the image list.
 *
 * Unknown prefixes get an empty list (deny everything); `assertAllowedTestPathname` rejects
 * those earlier, so this is only a belt-and-braces default.
 */
export function allowedContentTypesForPathname(pathname: string): string[] {
  const p = (pathname ?? "").replace(/^\/+/, "");
  if (p.startsWith(DOC_BLOB_PREFIX)) {
    if (p.endsWith(DOC_PREVIEW_PNG_SUFFIX)) return [...DOC_PREVIEW_ALLOWED_CONTENT_TYPES];
    return [...DOC_UPLOAD_ALLOWED_CONTENT_TYPES];
  }
  if (p.startsWith(ORG_AVATAR_PREFIX)) return [...AVATAR_UPLOAD_ALLOWED_CONTENT_TYPES];
  return [];
}

/**
 * Whether `buf` actually looks like a PDF, by content rather than by name or declared type.
 *
 * PDFs carry a `%PDF-` header near the start; some producers prepend a BOM or a little
 * whitespace first, so this scans a small prefix and allows for that. Shared by every route that
 * accepts file bytes from outside the browser's own file picker (a URL fetch, inline base64 from
 * an MCP tool call) — a filename or declared content-type is never trusted alone, only this is.
 */
export function looksLikePdfBytes(buf: Buffer): boolean {
  if (!buf || buf.length < 5) return false;
  const scanLen = Math.min(buf.length, 2048);
  const sig = Buffer.from("%PDF-", "ascii");

  let start = 0;
  if (scanLen >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  while (
    start < scanLen &&
    (buf[start] === 0x09 || buf[start] === 0x0a || buf[start] === 0x0d || buf[start] === 0x20)
  ) {
    start++;
  }
  if (start + sig.length <= scanLen && buf.subarray(start, start + sig.length).equals(sig)) return true;

  const idx = buf.subarray(0, scanLen).indexOf(sig);
  return idx >= 0 && idx <= 64; // keep it conservative; if it's far in, it's likely not a PDF body
}

/** Strip characters unsafe for a stored filename and force a `.pdf` extension. */
export function sanitizeFileName(name: string): string {
  const cleaned = (name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "_")
    .replace(/\s+/g, " ");
  const base = cleaned || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/** User-facing message returned (with `UNSUPPORTED_FILE_TYPE_CODE`) when a non-PDF document is submitted. */
export const PDF_ONLY_ERROR_MESSAGE = "Only PDF files are supported right now.";
/** Machine-readable error code paired with `PDF_ONLY_ERROR_MESSAGE` (HTTP 415). */
export const UNSUPPORTED_FILE_TYPE_CODE = "UNSUPPORTED_FILE_TYPE";

/**
 * Return whether upload metadata describes a PDF.
 *
 * Accepts when the content type is `application/pdf` or the file name ends in `.pdf`
 * (browsers sometimes report an empty type for PDFs), and rejects when either signal is
 * present and explicitly says otherwise (e.g. `image/png`, `photo.jpg`).
 */
export function isPdfUploadMeta(params: { contentType?: string | null; fileName?: string | null }): boolean {
  const ct = ((params.contentType ?? "").trim().toLowerCase().split(";")[0] ?? "").trim();
  const name = (params.fileName ?? "").trim().toLowerCase();
  if (ct && ct !== "application/pdf") return false;
  if (name && !name.endsWith(".pdf")) return false;
  return ct === "application/pdf" || name.endsWith(".pdf");
}

/**
 * Max file size for client uploads. Much larger than the server-side import ceiling because these
 * bytes go from the browser straight to Blob and never pass through a function body; the number
 * itself lives with every other upload limit in `src/lib/limits/uploads.ts`.
 */
export const CLIENT_UPLOAD_MAX_SIZE_BYTES = BROWSER_DIRECT_UPLOAD_MAX_BYTES;

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
