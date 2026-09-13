/**
 * Daily caps for recipient uploads (request links and replace links).
 *
 * A recipient upload runs the automatic AI summary at the owner's expense in compute but at 0
 * credits (see `recordUnbilledRun`), so without a brake a public link could be used to burn model
 * cost indefinitely. Two independent caps, both per rolling 24h:
 * - per link token: `RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY` uploads,
 * - per Free workspace, across all its links: `FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY`.
 * Pro workspaces have only the per-token cap.
 */
import { Types } from "mongoose";

import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";

export const RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY = 20;
export const FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY = 20;
export const RECIPIENT_UPLOAD_LIMIT_CODE = "RECIPIENT_UPLOAD_LIMIT";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecipientCapResult =
  | { ok: true }
  | { ok: false; scope: "token" | "workspace"; limit: number; message: string };

/**
 * Checks the caps for one more upload through a request link (`requestProjectId`) or a replace
 * link (`replaceDocId`). Read-only; the caller creates the upload only on `ok`.
 * Errors: DB failures propagate.
 */
export async function checkRecipientUploadCap(params: {
  orgId: Types.ObjectId;
  requestProjectId?: Types.ObjectId | null;
  replaceDocId?: Types.ObjectId | null;
  now?: Date;
}): Promise<RecipientCapResult> {
  const since = new Date((params.now ?? new Date()).getTime() - DAY_MS);

  let tokenCount = 0;
  if (params.requestProjectId) {
    tokenCount = await DocModel.countDocuments({
      receivedViaRequestProjectId: params.requestProjectId,
      createdDate: { $gte: since },
    });
  } else if (params.replaceDocId) {
    tokenCount = await UploadModel.countDocuments({
      docId: params.replaceDocId,
      uploadSecret: { $ne: null },
      createdDate: { $gte: since },
    });
  }
  if (tokenCount >= RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY) {
    return {
      ok: false,
      scope: "token",
      limit: RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY,
      message: `This link has received ${RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY} uploads in the last 24 hours. Try again later.`,
    };
  }

  const plan = await getWorkspacePlan(params.orgId).catch(() => "free" as const);
  if (plan !== "pro") {
    const workspaceCount = await UploadModel.countDocuments({
      orgId: params.orgId,
      uploadSecret: { $ne: null },
      createdDate: { $gte: since },
    });
    if (workspaceCount >= FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY) {
      return {
        ok: false,
        scope: "workspace",
        limit: FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY,
        message: `This workspace has received ${FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY} uploads through links in the last 24 hours. Try again later.`,
      };
    }
  }
  return { ok: true };
}
