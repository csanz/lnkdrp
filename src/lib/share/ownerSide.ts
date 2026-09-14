/**
 * "Is the person behind this request on the *owning* side of the document?"
 *
 * The owning side is the document's owner and every member of the workspace that owns it. Their
 * opens and downloads are recorded — an owner checking their own link is real, debuggable activity,
 * and deleting it makes a broken link indistinguishable from an unopened one — but they are flagged
 * with `isOwnerPreview` and excluded from every figure the owner reads. A deck opened four times by
 * its author and never by an investor reported "4 views · 1 person", which is the opposite of the
 * truth the metrics page exists to tell.
 *
 * This lives in one module because it is asked on two unrelated request paths — the stats ingest
 * and the public PDF route — and they had already drifted: the ingest flagged owner *views* while
 * the PDF route never read the session at all, so an owner downloading their own deck still bumped
 * the link's download counter and wrote "Someone downloaded this" into the owner's own feed.
 *
 * Best-effort by nature: it needs a signed-in session on the request. An owner who opens their own
 * link in a logged-out browser is indistinguishable from a recipient and counts as one.
 */
import { Types } from "mongoose";

import { OrgMembershipModel } from "@/lib/models/OrgMembership";

/** The document fields this needs: its owner, and the workspace that owns it. */
export type OwnedDocLike = { orgId?: unknown; userId?: unknown };

export async function isOwnerSideViewer(
  doc: OwnedDocLike,
  viewerUserId: Types.ObjectId | string | null,
): Promise<boolean> {
  if (!viewerUserId) return false;
  const viewerId = String(viewerUserId);
  if (!Types.ObjectId.isValid(viewerId)) return false;
  try {
    // Legacy documents predate workspaces and carry only an owner `userId`.
    const ownerUserId = doc?.userId ? String(doc.userId) : "";
    if (ownerUserId && ownerUserId === viewerId) return true;
    const docOrgId = doc?.orgId ? String(doc.orgId) : "";
    if (!docOrgId || !Types.ObjectId.isValid(docOrgId)) return false;
    // A teammate's open is an owner-side open too: on a shared workspace the deck's traffic must
    // not include the four colleagues who clicked it in Slack before it was sent to anyone.
    return Boolean(
      await OrgMembershipModel.exists({
        orgId: new Types.ObjectId(docOrgId),
        userId: new Types.ObjectId(viewerId),
        isDeleted: { $ne: true },
      }),
    );
  } catch {
    // A membership lookup that fails must not turn a real recipient's view into a dropped one.
    return false;
  }
}
