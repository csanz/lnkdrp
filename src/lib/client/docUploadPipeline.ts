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
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname } from "@/lib/blob/clientUpload";
import { debugError, debugLog } from "@/lib/debug";
import { fetchJson } from "@/lib/http/fetchJson";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { notifyDocsChanged } from "@/lib/sidebarCache";
import { OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { dispatchOutOfCredits } from "@/lib/client/outOfCredits";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";

export type CreateDocResponse = { doc: { id: string } };
export type CreateUploadResponse = { upload: { id: string } };

export type CreateUploadInput = {
  docId: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
};

/**
 * Create a new document record.
 */
export async function apiCreateDoc(params: { title: string }): Promise<string> {
  const json = await fetchJson<CreateDocResponse>("/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: params.title }),
  });
  return json.doc.id;
}

/**
 * Create a new upload record for a document.
 */
export async function apiCreateUpload(input: CreateUploadInput): Promise<string> {
  const json = await fetchJson<CreateUploadResponse>("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return json.upload.id;
}

/**
 * Start a background upload to Vercel Blob, then trigger server-side processing.
 *
 * This function is deliberately non-throwing (it runs "fire and forget").
 * If you need immediate error feedback, do the upload inline instead.
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
      const pathname = buildDocBlobPathname({
        docId,
        uploadId,
        fileName: file.name,
      });

      debugLog(1, "[docUploadPipeline] blob upload starting", { docId, uploadId, pathname });
      const blob = await blobUpload(pathname, file, {
        access: "public",
        handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
        contentType: file.type || undefined,
      });

      await fetchJson(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "uploaded",
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          metadata: { size: file.size },
        }),
      });

      debugLog(1, "[docUploadPipeline] trigger processing", { uploadId });
      const res = await fetchWithTempUser(`/api/uploads/${uploadId}/process`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as any;
        if (res.status === 402 && (json?.code === OUT_OF_CREDITS_CODE || json?.error === "Out of credits")) {
          dispatchOutOfCredits();
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






