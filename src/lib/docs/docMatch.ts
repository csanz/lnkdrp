/**
 * "Which document may this actor act on?" — in one place.
 *
 * Documents are owned by a **workspace**, and every read surface has scoped them that way since
 * workspaces shipped: the sidebar, the document page, metrics. One write path did not.
 * `/api/uploads` looked a document up by `{ _id, userId: actor.userId }` — the *owner's* id — so an
 * invited member of a shared workspace could open a document, read it and see its links, then get
 * "Doc not found" the moment they tried to replace the file. Nothing in that message suggested the
 * real answer, which was that one route disagreed with the rest of the product about who a document
 * belongs to.
 *
 * `allowLegacyByUserId` is for documents that predate workspaces and carry no `orgId`. Those belong
 * to a person, so they resolve only while that person is in their **own** personal workspace, never
 * from a team workspace where "my old files" is not what the reader is looking at.
 */
import type { Types } from "mongoose";

export function buildDocMatch(
  docObjectId: Types.ObjectId,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
): Record<string, unknown> {
  // A soft-deleted document is gone: GET used to keep serving it and PATCH kept editing it, and a
  // second DELETE logged a second doc.deleted row.
  const notDeleted = { isDeleted: { $ne: true } };
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        $or: [
          { _id: docObjectId, orgId },
          { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: docObjectId, orgId, ...notDeleted };
}
