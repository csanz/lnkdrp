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
 *
 * `lockedExclusion` is the locked-room half (docs/prds/lnkdrp-locked-projects.md, decision 11). It is
 * a **required** argument and not an optional one, because this single function is what about twenty
 * by-id document routes resolve through, and an argument that can be omitted is an argument a new
 * route omits. The lock is access rather than discovery, which is a deliberate divergence from the
 * containment rule next door in `src/lib/docs/visibility.ts`: containment changes what is listed and
 * leaves a named document reachable, so without this clause the feature would be a listing filter
 * with a padlock icon and the document page, the PDF bytes, the extracted text, every per-audience
 * link slug and its password would all stay one guessed id away.
 *
 * The function stays PURE, deliberately: the caller does the grant read (it has the `Request` in hand
 * for the memo, and it usually needs the hidden set for something else on the same page), and
 * `tests/lib/docMatchConversions.test.ts` compares a route's filter against a filter it builds itself,
 * which only works while this is a function of its arguments.
 */
import type { Types } from "mongoose";

export function buildDocMatch(
  docObjectId: Types.ObjectId,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
  /** `lockedHomeExclusion(await hiddenProjectIds(...))`, or `{}` for the recipient-side routes. */
  lockedExclusion: Record<string, unknown>,
): Record<string, unknown> {
  // A soft-deleted document is gone: GET used to keep serving it and PATCH kept editing it, and a
  // second DELETE logged a second doc.deleted row.
  const notDeleted = { isDeleted: { $ne: true } };
  // Into `$and`, and only when there is something to hide. The legacy branch already owns the
  // top-level `$or`, and several callers spread this result into a filter literal of their own, so a
  // bare `$nor` sibling would be one refactor away from being replaced by somebody else's key. An
  // empty exclusion adds nothing at all, which is what keeps a workspace with no locked room on a
  // filter byte-identical to the one it had before this feature existed.
  const locked = Object.keys(lockedExclusion).length > 0 ? { $and: [lockedExclusion] } : {};
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        ...locked,
        $or: [
          { _id: docObjectId, orgId },
          { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: docObjectId, orgId, ...notDeleted, ...locked };
}
