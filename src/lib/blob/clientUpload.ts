/**
 * Client-upload utilities for Vercel Blob.
 *
 * This file is imported by client components (browser runtime).
 * Keep it free of Node-only APIs so it can safely bundle for the client.
 *
 * Docs: https://vercel.com/docs/vercel-blob/client-upload
 */

export const BLOB_HANDLE_UPLOAD_URL = "/api/blob/upload";

/**
 * We keep all test uploads under a single prefix, so the server can cheaply
 * validate the pathname and avoid minting tokens for arbitrary destinations.
 */
export const TEST_BLOB_PREFIX = "client-tests/";

/**
 * Canonical prefix for real document uploads + derived artifacts.
 */
export const DOC_BLOB_PREFIX = "docs/";

/**
 * ISO timestamp safe for URLs/pathnames (no ":" or ".").
 */
export function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Build a destination pathname for client uploads.
 *
 * Example:
 *   client-tests/2025-12-16T01-02-03-000Z/sample/skycatch.jpg
 */
export function buildTestBlobPathname(params: {
  label: string;
  fileName: string;
  timestamp?: string;
}): string {
  const ts = params.timestamp ?? safeTimestamp();
  return `${TEST_BLOB_PREFIX}${ts}/${params.label}/${params.fileName}`;
}

function sanitizePathSegment(s: string) {
  // Keep it boring and URL/path safe.
  return (s || "file")
    .trim()
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replaceAll("..", ".")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildDocBlobPathname(params: {
  docId: string;
  uploadId: string;
  fileName: string;
  timestamp?: string;
}): string {
  const ts = params.timestamp ?? safeTimestamp();
  const safeName = sanitizePathSegment(params.fileName);
  // Deterministic per uploadId, timestamped so replace-file doesn't collide.
  return `${DOC_BLOB_PREFIX}${params.docId}/uploads/${params.uploadId}/${ts}-${safeName}`;
}

export function buildDocPreviewPngPathname(params: {
  docId: string;
  uploadId: string;
}): string {
  return `${DOC_BLOB_PREFIX}${params.docId}/uploads/${params.uploadId}/preview.png`;
}

/**
 * Fetch a public asset from this Next.js app and wrap it as a `File` so it can
 * be passed to the Blob client upload() API.
 */
export async function fetchPublicFileAsFile(params: {
  url: string;
  filename: string;
  contentType: string;
}): Promise<File> {
  const res = await fetch(params.url);
  if (!res.ok) throw new Error(`Failed to fetch ${params.url}`);
  const blob = await res.blob();
  return new File([blob], params.filename, { type: params.contentType });
}

export const SAMPLE_UPLOADS = {
  image: {
    url: "/sample/skycatch.jpg",
    filename: "skycatch.jpg",
    contentType: "image/jpeg",
    label: "sample",
  },
  pdf: {
    url: "/sample/usavx.pdf",
    filename: "usavx.pdf",
    contentType: "application/pdf",
    label: "sample",
  },
} as const;




