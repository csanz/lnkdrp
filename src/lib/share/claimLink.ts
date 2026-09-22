/**
 * The link a download claim is permission *through* — document link or data-room link.
 *
 * An approved download request is not a standing right to a file: it is permission to take this
 * document through the link the recipient actually used, and it dies with that link. Every claim
 * route therefore re-proves the link before serving bytes — refused links 404, password-protected
 * links still want the password.
 *
 * The gate was right and the resolver was too narrow. All three claim routes called
 * `resolveShareLink`, which refuses a project slug by design (a project link has no document of its
 * own), so a request made from inside a data room could be created and approved and then failed at
 * the claim with a 404. The product's answer was to hide "Request download" in a room entirely.
 *
 * This is that resolver widened to both shapes, in one place so the three routes cannot drift apart
 * again. It deliberately returns only what the gate needs — the link and why it must be refused —
 * because each caller already loads the document it was approved for.
 */
import type { Types } from "mongoose";

import { resolveShareLink, type ResolvedShareLink } from "@/lib/share/links";
import { resolveProjectLink, type ResolvedProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument } from "@/lib/share/projectPublic";
import type { ShareLink } from "@/lib/models/ShareLink";

export type ResolvedClaimLink = {
  link: ShareLink;
  /** Why a claim must be refused, or null when the link may serve. */
  refusal: ResolvedShareLink["refusal"] | ResolvedProjectLink["refusal"];
};

/**
 * Resolve the link a claim is being made through, for the document it was approved for.
 *
 * `null` means "no such claim": either the slug matches nothing, or it matches a link that has
 * nothing to do with `docId`. Callers answer that with a 404, exactly as they did before — the
 * point of returning null rather than throwing is that a stranger holding a stale token learns
 * nothing from the difference.
 *
 * The `docId` argument is the security-relevant half. A data-room link fronts many documents, so
 * proving the slug resolves is not enough: the approval was minted against one document, and this
 * re-proves that document is still in that room. Without it, an approval for one document in a room
 * would be a claim token for every document in it.
 */
export async function resolveClaimLink(
  shareId: string,
  docId: string | Types.ObjectId,
): Promise<ResolvedClaimLink | null> {
  const slug = (shareId ?? "").toString().trim();
  const wanted = String(docId ?? "").trim();
  if (!slug || !wanted) return null;

  const direct = await resolveShareLink(slug);
  if (direct) {
    // A document link carries exactly one document; if it is not the approved one, this token does
    // not belong to this link.
    if (String((direct.doc as { _id?: unknown })._id ?? "") !== wanted) return null;
    return { link: direct.link, refusal: direct.refusal };
  }

  const project = await resolveProjectLink(slug);
  if (!project) return null;
  // Still in the room? `findProjectDocument` is the same membership proof `/p/:slug/:docId` uses,
  // so a document removed from the project after approval stops claiming with it.
  const doc = await findProjectDocument(project.project, wanted);
  if (!doc) return null;
  return { link: project.link, refusal: project.refusal };
}
