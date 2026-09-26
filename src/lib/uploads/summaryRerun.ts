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
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { UploadModel } from "@/lib/models/Upload";
import { triggerUploadProcessing } from "@/lib/uploads/internalProcess";

export type SummaryRerunResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 502; code: "not_found" | "not_current" | "not_skipped" | "busy" | "trigger_failed"; error: string };

/** Skip states a rerun can fix. A summary that was written ("done") is never rerun. */
const RERUNNABLE = new Set(["skipped", "failed"]);

/**
 * Queue a summary-only rerun for `uploadId` and trigger processing.
 *
 * `orgId` is the caller's authorization: the document must belong to that workspace. The check used
 * to read `if (params.orgId && doc.orgId && ...)`, and the middle conjunct was the hole — a document
 * with no `orgId` (every document that predates workspaces; `Doc.orgId` defaults to null) skipped
 * the comparison entirely, so any signed-in member of any workspace could name someone else's legacy
 * upload and have its summary rewritten. The credit is not even billed to the caller: processing
 * resolves the billing workspace from the *upload's* owner, so the spend lands on the victim, and
 * `aiOutput` is cleared before the run starts, so a refusal downstream still destroys what was there.
 *
 * It now asks `buildDocMatch`, which is the one rule for "which document may this actor act on" and
 * already says that a legacy document resolves only for its owner, and only from that owner's own
 * workspace. Callers that cannot answer "whose personal workspace is this" simply do not get the
 * legacy branch — a rerun refused is recoverable, a rerun on the wrong document is not.
 */
export async function queueSummaryRerun(params: {
  uploadId: string;
  origin: string;
  orgId?: string | null;
  /** The caller, for the legacy (org-less document) branch. Omit and that branch is refused. */
  userId?: string | null;
  /** The caller's own workspace, for the same branch. */
  personalOrgId?: string | null;
}): Promise<SummaryRerunResult> {
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

  const callerOrgId = typeof params.orgId === "string" && Types.ObjectId.isValid(params.orgId) ? params.orgId : null;
  const callerUserId = typeof params.userId === "string" && Types.ObjectId.isValid(params.userId) ? params.userId : null;
  const allowLegacyByUserId = Boolean(
    callerOrgId && callerUserId && params.personalOrgId && callerOrgId === params.personalOrgId,
  );
  /**
   * The locked-room half, and only when a person is named.
   *
   * With a `userId` this is a member pressing "Write summary", so a document whose home is a room
   * they are not in must answer not found like every other by-id surface
   * (docs/prds/lnkdrp-locked-projects.md, decision 11). Without one the caller is
   * `requeueSkippedSummaries`, which sweeps a workspace's skipped summaries when its subscription
   * becomes billable: there is no viewer on that path, the credit belongs to the workspace rather
   * than to a person, and a locked room's own members are the ones who would otherwise be left with
   * a permanently blank summary. So it is deliberately lock-free, for the same reason the plan cap
   * is (decision 29): the system counting or finishing its own work is not somebody reading a room.
   */
  const lockedExclusion =
    callerOrgId && callerUserId ? await lockedHomeExclusionFor(callerOrgId, callerUserId) : {};
  const docMatch = callerOrgId
    ? buildDocMatch(
        upload.docId,
        new Types.ObjectId(callerOrgId),
        new Types.ObjectId(callerUserId ?? callerOrgId),
        allowLegacyByUserId,
        lockedExclusion,
      )
    : // No workspace given at all: an internal caller that has already done its own scoping.
      { _id: upload.docId, isDeleted: { $ne: true } };
  const doc = (await DocModel.findOne(docMatch)
    .select({ orgId: 1, currentUploadId: 1, uploadId: 1 })
    .lean()) as { orgId?: Types.ObjectId | null; currentUploadId?: Types.ObjectId | null; uploadId?: Types.ObjectId | null } | null;
  if (!doc) return { ok: false, status: 404, code: "not_found", error: "Document not found" };
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
