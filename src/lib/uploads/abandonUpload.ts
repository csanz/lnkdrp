/**
 * Undo what `POST /api/uploads` did when the file never arrives.
 *
 * Creating an upload flips its document to `preparing` and points `currentUploadId` at the new,
 * still-empty upload. If the import then fails (not a PDF, a 404 URL, bad base64, too large),
 * nothing ever processes that upload, so the document sat in `preparing` forever: recipients saw
 * a document that never finished, the version counter had moved on, and `lnkdrp_delete_doc`
 * refused because the document was "still being processed". That is how a real deck got stuck.
 *
 * Abandoning marks the upload failed (and hidden, returning its version number when it can) and, if it is still the document's current upload, points
 * the document back at its newest completed upload (status `ready`), or at `failed` when it never
 * had one.
 */
import { Types } from "mongoose";

import { debugLog } from "@/lib/debug";
import type { Actor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { createUploadProgressReporter } from "@/lib/uploads/progressWriter";
import { connectMongo } from "@/lib/mongodb";

export async function abandonUpload(input: { uploadId: string; userId: string; reason: string }): Promise<void> {
  if (!Types.ObjectId.isValid(input.uploadId) || !Types.ObjectId.isValid(input.userId)) return;
  await connectMongo();
  const upload = await UploadModel.findOne({
    _id: new Types.ObjectId(input.uploadId),
    userId: new Types.ObjectId(input.userId),
    status: "uploading",
    isDeleted: { $ne: true },
  })
    .select({ _id: 1, docId: 1, version: 1 })
    .lean();
  if (!upload?.docId) return;

  // The upload never had a file, so it is not a version anyone can see: hide it from version
  // history and hand its number back when no later upload has taken one. Otherwise the next good
  // replace jumped from v2 to v4.
  await UploadModel.updateOne(
    { _id: upload._id, status: "uploading" },
    { $set: { status: "failed", isDeleted: true, error: { message: input.reason } } },
  );
  if (typeof upload.version === "number") {
    await DocModel.updateOne({ _id: upload.docId, versionCounter: upload.version }, { $inc: { versionCounter: -1 } });
  }
  const previous = await UploadModel.findOne({
    docId: upload.docId,
    _id: { $ne: upload._id },
    status: "completed",
    isDeleted: { $ne: true },
  })
    .sort({ version: -1 })
    .select({ _id: 1 })
    .lean();
  const restore = previous
    ? { status: "ready", currentUploadId: previous._id, uploadId: previous._id }
    : { status: "failed" };
  const res = await DocModel.updateOne({ _id: upload.docId, currentUploadId: upload._id }, { $set: restore });
  // Stop the live bar: a watcher on the Activity feed would otherwise be left with an entry that
  // simply stopped moving, with nothing saying the import never happened.
  await createUploadProgressReporter({ uploadId: String(upload._id), docId: String(upload.docId) })
    .report("failed", { force: true })
    .catch(() => undefined);
  debugLog(1, "[uploads] abandoned upload after failed import", {
    uploadId: input.uploadId,
    docId: String(upload.docId),
    restoredTo: previous ? String(previous._id) : "failed",
    docUpdated: res.modifiedCount > 0,
  });
}

/**
 * Called by the import routes with their response. Abandons the upload on any failure except the
 * ones that say the caller had no business touching it (401/403/404), so a stranger's request
 * cannot abandon someone else's upload.
 */
export async function abandonUploadIfImportFailed(res: Response, uploadId: string, actor: Actor | null): Promise<void> {
  if (res.ok || !actor || [401, 403, 404].includes(res.status)) return;
  const reason = await res
    .clone()
    .json()
    .then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error : `import failed (${res.status})`))
    .catch(() => `import failed (${res.status})`);
  await abandonUpload({ uploadId, userId: actor.userId, reason }).catch(() => undefined);
}
