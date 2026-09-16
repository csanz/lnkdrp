/**
 * Re-run skipped AI summaries after a workspace gains a way to pay for them — today, when a Free
 * workspace's pay-as-you-go subscription becomes billable (the Stripe webhook calls this).
 *
 * Finds the current version of each live document in the workspace whose summary was skipped for
 * want of credits (`Upload.ai.code` `out_of_credits` or `daily_cap`) and queues a summary-only rerun
 * for each, newest first, up to `limit`. Each rerun reserves its own credit, so a workspace that
 * runs out part-way simply leaves the rest skipped.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { queueSummaryRerun } from "@/lib/uploads/summaryRerun";

export async function requeueSkippedSummaries(params: {
  orgId: string;
  /** Absolute origin of the app (e.g. `https://lnkdrp.com`) used to trigger processing. */
  origin: string;
  /** Max uploads to re-queue in one call (default 10). */
  limit?: number;
}): Promise<{ queued: number }> {
  if (!Types.ObjectId.isValid(params.orgId)) return { queued: 0 };
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
  await connectMongo();
  const docs = (await DocModel.find({ orgId: new Types.ObjectId(params.orgId), isDeleted: { $ne: true } })
    .select({ currentUploadId: 1, uploadId: 1 })
    .lean()) as Array<{ currentUploadId?: Types.ObjectId | null; uploadId?: Types.ObjectId | null }>;
  const currentIds = docs.map((d) => d.currentUploadId ?? d.uploadId).filter((id): id is Types.ObjectId => Boolean(id));
  if (!currentIds.length) return { queued: 0 };

  const skipped = (await UploadModel.find({
    _id: { $in: currentIds },
    status: "completed",
    isDeleted: { $ne: true },
    "ai.summary": "skipped",
    "ai.code": { $in: ["out_of_credits", "daily_cap"] },
    summaryRerun: { $ne: true },
  })
    .sort({ updatedDate: -1 })
    .limit(limit)
    .select({ _id: 1 })
    .lean()) as Array<{ _id: Types.ObjectId }>;

  let queued = 0;
  for (const u of skipped) {
    const res = await queueSummaryRerun({ uploadId: String(u._id), origin: params.origin, orgId: params.orgId });
    if (res.ok) queued += 1;
  }
  return { queued };
}
