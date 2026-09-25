/**
 * Put a document back on its last good version after an upload fails.
 *
 * `POST /api/uploads` and the replace-link route move a document to `preparing` and point
 * `currentUploadId` at the new Upload row the moment it is created, before a byte has arrived.
 * When that upload then fails, the failure paths in the processing job were all guarded with
 * `if (!isReplacement)` so as not to overwrite the last good version with `failed`, and the
 * read-time repair in `GET /api/docs/:docId` only recognised an upload that never started
 * (`uploading` with no `blobUrl`). A replacement whose processing failed therefore left the
 * document in `preparing`, pointing at a failed upload, for good: recipients saw a document that
 * never finished and the owner could neither retry nor delete it (code review 2026-09-23, M5).
 *
 * This is the one routine for that recovery, shared by the import abandon path, the processing
 * job and the read-time repair. The document only moves if the failed upload is still its current
 * one, so a newer upload that has since taken over is never clobbered.
 */
import { Types } from "mongoose";

import { debugLog } from "@/lib/debug";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";

export type RestoreDocOutcome = {
  /** The upload the document now points at, or null when it never had a completed one. */
  restoredTo: string | null;
  /** The document status written: `ready` with a last good version, `failed` without one (`draft` when asked). */
  status: "ready" | "failed" | "draft";
  /** Whether the document row was actually changed (false when a newer upload had already taken over). */
  docUpdated: boolean;
};

/**
 * Point `docId` at its newest completed upload other than `failedUploadId`, restoring status,
 * blob and preview from it; with no completed upload the document becomes `failed` (or
 * `noVersionStatus` when the caller prefers `draft`, as the read-time repair does for a document
 * that never had a file).
 */
export async function restoreDocToLastGood(input: {
  docId: Types.ObjectId | string;
  failedUploadId: Types.ObjectId | string;
  noVersionStatus?: "failed" | "draft";
}): Promise<RestoreDocOutcome> {
  const docId = new Types.ObjectId(String(input.docId));
  const failedUploadId = new Types.ObjectId(String(input.failedUploadId));
  const lastGood = (await UploadModel.findOne({
    docId,
    _id: { $ne: failedUploadId },
    status: "completed",
    isDeleted: { $ne: true },
  })
    .sort({ version: -1 })
    .select({ _id: 1, blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1 })
    .lean()) as { _id: Types.ObjectId; blobUrl?: string | null; previewImageUrl?: string | null; firstPagePngUrl?: string | null } | null;

  const status: RestoreDocOutcome["status"] = lastGood ? "ready" : (input.noVersionStatus ?? "failed");
  const preview = lastGood?.previewImageUrl ?? lastGood?.firstPagePngUrl ?? null;
  const set: Record<string, unknown> = { status };
  if (lastGood) {
    set.currentUploadId = lastGood._id;
    set.uploadId = lastGood._id;
    if (lastGood.blobUrl) set.blobUrl = lastGood.blobUrl;
    if (preview) {
      set.previewImageUrl = preview;
      set.firstPagePngUrl = preview;
    }
  }
  const res = await DocModel.updateOne({ _id: docId, currentUploadId: failedUploadId }, { $set: set });
  const outcome: RestoreDocOutcome = {
    restoredTo: lastGood ? String(lastGood._id) : null,
    status,
    docUpdated: res.modifiedCount > 0,
  };
  debugLog(1, "[uploads] document restored after failed upload", {
    docId: String(docId),
    failedUploadId: String(failedUploadId),
    ...outcome,
  });
  return outcome;
}
