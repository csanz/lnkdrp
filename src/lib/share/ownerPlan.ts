/**
 * "Is the workspace that owns this shared document entitled to the recipient-facing version
 * history?" — asked on the *read* path, by every route that serves it.
 *
 * It has to be asked there. The per-link `allowRevisionHistory` toggle is gated when it is set
 * (`createShareLink` / `updateShareLink` run `checkLimit`), and a write-time gate only describes
 * the moment of the write: a workspace that turned the toggle on while on Pro and then downgraded
 * kept serving history to recipients forever, because no read ever asked what plan the owner is on
 * today. Two routes serve this history — `/s/:shareId/changes` (cookie-scoped, for the share page)
 * and `/api/share/:shareId/changes` — and they answered differently, which is the failure this
 * shared helper exists to prevent.
 *
 * Legacy documents predate workspaces and carry only an owner `userId`; their personal workspace is
 * the one that holds the plan, so it is resolved here rather than treated as "no workspace, allow".
 */
import { Types } from "mongoose";

import { checkLimit } from "@/lib/billing/planLimits";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

/**
 * Resolve the owning workspace of a shared doc and ask whether it may show recipients its version
 * history. Returns `false` on any failure: the safe direction is to withhold the owner's revision
 * summaries, not to serve them because a plan lookup threw.
 */
export async function ownerCanShowVersionHistory(doc: { orgId?: unknown; userId?: unknown }): Promise<boolean> {
  try {
    let orgId: Types.ObjectId | null =
      doc.orgId && Types.ObjectId.isValid(String(doc.orgId)) ? new Types.ObjectId(String(doc.orgId)) : null;
    if (!orgId && doc.userId && Types.ObjectId.isValid(String(doc.userId))) {
      orgId = (await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(String(doc.userId)) })).orgId;
    }
    if (!orgId) return false;
    const gate = await checkLimit(orgId, "version_history");
    return gate.ok;
  } catch {
    return false;
  }
}
