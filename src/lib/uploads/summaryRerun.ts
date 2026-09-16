/**
 * Write a skipped AI summary later.
 *
 * When a workspace is out of credits the upload still completes and the summary is skipped
 * (`Upload.ai.summary = "skipped"`). This queues a summary-only rerun of that upload: the upload is
 * flipped back to `uploaded` with `summaryRerun: true` and the processing route is triggered with an
 * internal token. Processing reuses the stored preview, text and page images, runs only the summary
 * (1 credit, never the compare), records a `summary.generated` activity row and clears the flag.
 *
 * Used by `POST /api/uploads/:id/summary` (the doc page's "Write summary" action) and by
 * `requeueSkippedSummaries` when a workspace's pay-as-you-go subscription becomes billable.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { triggerUploadProcessing } from "@/lib/uploads/internalProcess";

export type SummaryRerunResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 502; code: "not_found" | "not_current" | "not_skipped" | "busy" | "trigger_failed"; error: string };

/** Skip states a rerun can fix. A summary that was written ("done") is never rerun. */
const RERUNNABLE = new Set(["skipped", "failed"]);

/**
 * Queue a summary-only rerun for `uploadId` and trigger processing.
 * `orgId`, when given, must match the document's workspace (the caller's authorization).
 */
export async function queueSummaryRerun(params: { uploadId: string; origin: string; orgId?: string | null }): Promise<SummaryRerunResult> {
  if (!Types.ObjectId.isValid(params.uploadId)) return { ok: false, status: 404, code: "not_found", error: "Upload not found" };
  await connectMongo();
  const uploadId = new Types.ObjectId(params.uploadId);
  const upload = (await UploadModel.findOne({ _id: uploadId, isDeleted: { $ne: true } })
    .select({ docId: 1, status: 1, ai: 1, aiOutput: 1, agentSummary: 1, summaryRerun: 1 })
    .lean()) as {
    docId?: Types.ObjectId | null;
    status?: string;
    ai?: { summary?: string } | null;
    aiOutput?: unknown;
    agentSummary?: unknown;
    summaryRerun?: boolean;
  } | null;
  if (!upload?.docId) return { ok: false, status: 404, code: "not_found", error: "Upload not found" };

  const doc = (await DocModel.findOne({ _id: upload.docId, isDeleted: { $ne: true } })
    .select({ orgId: 1, currentUploadId: 1, uploadId: 1 })
    .lean()) as { orgId?: Types.ObjectId | null; currentUploadId?: Types.ObjectId | null; uploadId?: Types.ObjectId | null } | null;
  if (!doc) return { ok: false, status: 404, code: "not_found", error: "Document not found" };
  if (params.orgId && doc.orgId && String(doc.orgId) !== String(params.orgId)) {
    return { ok: false, status: 404, code: "not_found", error: "Upload not found" };
  }
  const current = doc.currentUploadId ?? doc.uploadId ?? null;
  if (!current || String(current) !== String(uploadId)) {
    return { ok: false, status: 409, code: "not_current", error: "Only the current version's summary can be written" };
  }
  const state = upload.ai?.summary ?? (upload.aiOutput ? "done" : "skipped");
  if (upload.agentSummary || !RERUNNABLE.has(state)) {
    return { ok: false, status: 409, code: "not_skipped", error: "This version already has a summary" };
  }

  const claimed = await UploadModel.findOneAndUpdate(
    { _id: uploadId, status: "completed", summaryRerun: { $ne: true }, isDeleted: { $ne: true } },
    { $set: { status: "uploaded", summaryRerun: true, aiOutput: null }, $inc: { summaryRerunCount: 1 } },
    { new: true },
  ).lean();
  if (!claimed) return { ok: false, status: 409, code: "busy", error: "This version is already being processed" };

  const started = await triggerUploadProcessing({ origin: params.origin, uploadId: params.uploadId }).catch(() => false);
  if (!started) {
    // Put the upload back exactly as it was so the action can be retried.
    await UploadModel.updateOne(
      { _id: uploadId, status: "uploaded", summaryRerun: true },
      { $set: { status: "completed", summaryRerun: false, aiOutput: upload.aiOutput ?? null } },
    );
    return { ok: false, status: 502, code: "trigger_failed", error: "Could not start the summary. Try again." };
  }
  return { ok: true };
}
