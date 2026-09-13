/**
 * Client-side helpers for starting the "upload → process" pipeline.
 *
 * This consolidates logic that is shared between:
 * - `/` (create doc + first upload)
 * - `/doc/:id` (replace file, create a new upload + reprocess)
 *
 * It intentionally:
 * - keeps uploads non-blocking (UI can navigate / update immediately)
 * - uses Vercel Blob client uploads (browser → Blob direct)
 * - updates our DB state via REST routes (`/api/uploads/*`)
 */

import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname, buildDocPreviewPngPathname } from "@/lib/blob/clientUpload";
import { debugError, debugLog } from "@/lib/debug";
import { parsePlanLimitError, type PlanLimitError } from "@/lib/client/planLimit";
import { extractErrorMessage, fetchJson } from "@/lib/http/fetchJson";
import { fetchWithTempUser, tempUserHeaders } from "@/lib/gating/tempUserClient";
import { notifyDocsChanged } from "@/lib/sidebarCache";
import { OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { dispatchOutOfCredits, outOfCreditsReasonFromCode } from "@/lib/client/outOfCredits";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";

export type CreateDocResponse = { doc: { id: string } };
export type CreateUploadResponse = { upload: { id: string; version?: number | null } };

export type CreateUploadInput = {
  docId: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
};

/** User-facing message shown when a non-PDF file is picked (documents are PDF-only for now). */
export const PDF_ONLY_MESSAGE = "Only PDF files are supported right now.";

/**
 * Return whether a picked `File` is a PDF.
 *
 * Accepts `application/pdf` or a `.pdf` extension (some platforms report an empty MIME type),
 * and rejects when either signal explicitly says otherwise.
 */
export function isPdfFile(file: Pick<File, "name" | "type">): boolean {
  return isPdfMeta({ contentType: file.type, fileName: file.name });
}

/**
 * Same rule as `isPdfFile`, for callers that only have the name/type strings.
 */
export function isPdfMeta(params: { contentType?: string | null; fileName?: string | null }): boolean {
  const ct = ((params.contentType ?? "").trim().toLowerCase().split(";")[0] ?? "").trim();
  const name = (params.fileName ?? "").trim().toLowerCase();
  if (ct && ct !== "application/pdf") return false;
  if (name && !name.endsWith(".pdf")) return false;
  return ct === "application/pdf" || name.endsWith(".pdf");
}

/**
 * Best-effort client-side PDF thumbnail renderer (first page → PNG).
 *
 * Exists to show an immediate preview without waiting for server-side processing.
 * Returns null for non-PDF inputs or when rendering fails; never throws.
 */
async function renderPdfFirstPagePngBestEffort(file: File): Promise<Blob | null> {
  try {
    const ct = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    const isPdf = ct === "application/pdf" || name.endsWith(".pdf");
    if (!isPdf) return null;

    const pdfBytes = new Uint8Array(await file.arrayBuffer());

    // Load PDF.js from our vendored ESM bundle in /public (same approach as PdfJsViewer).
    const pdfjsModuleUrl = "/pdfjs/pdf.min.mjs";
    const pdfjs = (await import(/* webpackIgnore: true */ pdfjsModuleUrl)) as any;

    // Best-effort thumbnail: disable worker for maximum compatibility.
    const loadingTask = pdfjs.getDocument({ data: pdfBytes, disableWorker: true });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);

    const scale = 2;
    const maxWidth = 1200;
    const baseViewport = page.getViewport({ scale });
    const finalScale = baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
    const viewport = page.getViewport({ scale: finalScale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });

    try {
      await pdf.destroy?.();
    } catch {
      // ignore
    }

    return pngBlob;
  } catch {
    return null;
  }
}

/** Thrown by `apiCreateDoc` when the workspace is at its Free link cap (HTTP 402 `plan_limit`). */
export class PlanLimitClientError extends Error {
  readonly planLimit: PlanLimitError;
  constructor(limit: PlanLimitError) {
    super("This workspace is at its link limit.");
    this.name = "PlanLimitClientError";
    this.planLimit = limit;
  }
}

/**
 * Creates a new doc via `/api/docs` and returns the doc id.
 *
 * Side effects: broadcasts `docs changed` so the sidebar refreshes immediately.
 * Errors: throws on non-2xx responses from the API.
 */
export async function apiCreateDoc(params: { title: string }): Promise<string> {
  const res = await fetchWithTempUser("/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: params.title }),
  });
  if (res.status === 402) {
    // Free link cap: hand the parsed limit to the caller so it can open the upgrade modal.
    const body = (await res.json().catch(() => null)) as unknown;
    const limit = parsePlanLimitError(body);
    if (limit) throw new PlanLimitClientError(limit);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as unknown;
    throw new Error(extractErrorMessage(body) ?? `Request failed: /api/docs (${res.status})`);
  }
  const json = (await res.json()) as CreateDocResponse;
  // Immediately tell the app shell sidebar to refresh so the new doc appears,
  // even while the blob upload + processing pipeline runs in the background.
  notifyDocsChanged();
  return json.doc.id;
}

/**
 * Creates an Upload row via `/api/uploads` and returns (uploadId, version).
 *
 * Exists to allocate a server-side Upload id before uploading bytes to Blob (so paths are stable).
 * Side effects: broadcasts `docs changed` since doc status/currentUpload pointers often change.
 * Errors: throws `PDF_ONLY_MESSAGE` before any request when the metadata is not a PDF (documents are
 * PDF-only); otherwise throws on non-2xx responses from the API.
 */
export async function apiCreateUpload(
  input: CreateUploadInput,
): Promise<{ id: string; version: number | null }> {
  // Fail fast: never allocate an Upload (and flip the doc to `preparing`) for a non-PDF.
  if (!isPdfMeta({ contentType: input.contentType, fileName: input.originalFileName })) {
    throw new Error(PDF_ONLY_MESSAGE);
  }
  const json = await fetchJson<CreateUploadResponse>("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // Creating an upload usually updates the doc's currentUploadId/status; refresh sidebar quickly.
  notifyDocsChanged();
  const v = (json as any)?.upload?.version;
  const version = typeof v === "number" && Number.isFinite(v) ? v : null;
  return { id: json.upload.id, version };
}

/**
 * Start a background upload to Vercel Blob, then trigger server-side processing.
 *
 * This is deliberately "fire and forget" so UIs can navigate immediately after starting an upload.
 * Side effects: updates Upload status/blobUrl via `/api/uploads/:id`, triggers processing, refreshes
 * credits snapshot UI (best-effort), and emits sidebar refresh events in a finally block.
 */
export function startBlobUploadAndProcess(params: {
  docId: string;
  uploadId: string;
  file: File;
  /**
   * Optional hook for when the pipeline fails. Useful for marking DB state
   * (e.g. setting upload/doc status to "failed").
   */
  onFailure?: (message: string) => void | Promise<void>;
}) {
  const { docId, uploadId, file, onFailure } = params;

  void (async () => {
    try {
      if (!isPdfFile(file)) throw new Error(PDF_ONLY_MESSAGE);
      const pathname = buildDocBlobPathname({
        docId,
        uploadId,
        fileName: file.name,
      });

      debugLog(1, "[docUploadPipeline] blob upload starting", { docId, uploadId, pathname });
      const name = (file.name || "").toLowerCase();
      const inferredContentType =
        file.type || (name.endsWith(".pdf") ? "application/pdf" : undefined);
      // `/api/blob/upload` authorizes the token by upload ownership; signed-out callers are
      // identified only by the temp-user headers, which the Blob client does not send on its own.
      const identityHeaders = tempUserHeaders();
      const blob = await blobUpload(pathname, file, {
        access: "public",
        handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
        contentType: inferredContentType,
        headers: identityHeaders,
      });

      // Best-effort: generate a server-independent PDF thumbnail and attach it to the Upload.
      let previewImageUrl: string | null = null;
      try {
        const pngBlob = await renderPdfFirstPagePngBestEffort(file);
        if (pngBlob) {
          debugLog(2, "[docUploadPipeline] pdf preview rendered", {
            docId,
            uploadId,
            bytes: pngBlob.size,
          });
          const previewPathname = buildDocPreviewPngPathname({ docId, uploadId });
          // Wrap Blob in File for maximum compatibility with the Blob client upload API.
          const previewFile = new File([pngBlob], "preview.png", { type: "image/png" });
          const preview = await blobUpload(previewPathname, previewFile, {
            access: "public",
            handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
            contentType: "image/png",
            headers: identityHeaders,
          });
          previewImageUrl = preview.url;
          debugLog(1, "[docUploadPipeline] pdf preview uploaded", { docId, uploadId });
        } else {
          debugLog(2, "[docUploadPipeline] pdf preview skipped (not a PDF or render failed)", {
            docId,
            uploadId,
          });
        }
      } catch {
        debugLog(1, "[docUploadPipeline] pdf preview failed (continuing without preview)", {
          docId,
          uploadId,
        });
        // ignore (best-effort)
      }

      await fetchJson(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "uploaded",
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          previewImageUrl,
          metadata: { size: file.size },
        }),
      });

      debugLog(1, "[docUploadPipeline] trigger processing", { uploadId });
      const res = await fetchWithTempUser(`/api/uploads/${uploadId}/process`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as any;
        if (res.status === 402 && (json?.code === OUT_OF_CREDITS_CODE || json?.code === "DAILY_CREDIT_CAP" || json?.error === "Out of credits")) {
          dispatchOutOfCredits(outOfCreditsReasonFromCode(json?.code));
          throw new Error("Out of credits");
        }
        throw new Error(json?.error || `Request failed (${res.status})`);
      }

      // Best-effort: refresh credits + usage UI after triggering processing and again shortly after.
      // The server-side work runs in the background, so we can't know exact completion timing here.
      try {
        dispatchCreditsSnapshotRefresh();
        window.setTimeout(() => dispatchCreditsSnapshotRefresh(), 5_000);
        window.setTimeout(() => dispatchCreditsSnapshotRefresh(), 20_000);
      } catch {
        // ignore
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      debugError(1, "[docUploadPipeline] failed", { docId, uploadId, message });
      try {
        await onFailure?.(message);
      } catch {
        // ignore
      }
    } finally {
      // Best-effort: once processing is done (or fails), force sidebars/lists to re-sync
      // from server truth (version badge, status, totals, etc).
      notifyDocsChanged();
    }
  })();
}
