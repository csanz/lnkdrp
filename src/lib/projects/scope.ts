/**
 * The one definition of "a project that counts" for a workspace.
 *
 * The plan check and the project list each had their own copy of this filter, and they drifted: a
 * workspace showing one project was refused a second with "used: 2, max: 1" (2026-09-18), so the
 * cap blocked a slot the owner could not see. Both now build their query here — if a row is hidden
 * from the list it is not counted either, and if it is counted the owner can find it.
 *
 * Request repos are not projects in this sense: they are a separate feature with their own list,
 * and they are recognised either by `isRequest` or by carrying an upload token.
 */
import type { Types } from "mongoose";

/** Mongo conditions for the workspace's real, live projects. */
export function liveProjectFilter(orgId: Types.ObjectId): Record<string, unknown> {
  return {
    orgId,
    isDeleted: { $ne: true },
    $and: [
      { $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }] },
      { $or: [{ requestUploadToken: { $exists: false } }, { requestUploadToken: null }, { requestUploadToken: "" }] },
    ],
  };
}

/**
 * "Which project may this actor act on?" — the by-id counterpart of {@link liveProjectFilter}.
 *
 * The same twelve-line `$or` was pasted into five routes, and only one of them — the link gate in
 * `links/shared.ts` — remembered to exclude deleted rows. So a project in the trash could still be
 * renamed, re-described, given a new introduction and re-published by `PATCH
 * /api/projects/:id`, and it still answered `GET .../docs` and `.../suggested-docs`. Deleting a
 * project hid it from the sidebar and from the plan's project count; it did not stop anyone acting
 * on it, and a rename left an activity trail for a project nobody could open.
 *
 * `allowLegacyByUserId` follows the rule in `src/lib/docs/docMatch.ts`: projects that predate
 * workspaces carry no `orgId` and belong to a person, so they resolve only while that person is in
 * their own personal workspace.
 *
 * Who can actually be in this state: the user-facing `DELETE /api/projects/:id` is a **hard**
 * delete (`ProjectModel.deleteOne`), so `Project.isDeleted` is written only by the two admin data
 * routes and the org-delete sweep. That is a narrow door, but it is the door an owner cannot see
 * through — an admin retires a project and the owner keeps editing it.
 *
 * The list filters have to agree, or the fix trades one bug for a worse one: a row still listed but
 * refused by every route is a dead end the UI cannot clear. `/api/projects` already excluded
 * deleted rows; `/api/sidebar` and `/api/requests` did not, and now do.
 */
export function liveProjectByIdMatch(
  projectId: Types.ObjectId,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
): Record<string, unknown> {
  const notDeleted = { isDeleted: { $ne: true } };
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        $or: [
          { _id: projectId, orgId },
          { _id: projectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: projectId, orgId, ...notDeleted };
}

/**
 * The by-slug counterpart of {@link liveProjectByIdMatch}: the same tenancy and deletion bounds,
 * keyed on the workspace-unique `slug` instead of `_id`.
 *
 * Slugs are unique per workspace (`{ orgId, slug }`) and, for projects that predate workspaces,
 * per owner (`{ userId, slug }`), so the two alternatives of the legacy branch can never both
 * match a different row. The exact-match on `slug` is deliberate: the route lower-cases the
 * caller's slug before it gets here, and every stored slug is lower-case (`slugify`), so a regex
 * would only buy a collection scan.
 */
export function liveProjectBySlugMatch(
  slug: string,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
): Record<string, unknown> {
  const notDeleted = { isDeleted: { $ne: true } };
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        $or: [
          { slug, orgId },
          { slug, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { slug, orgId, ...notDeleted };
}

/**
 * True when the workspace still holds a live project with no stored slug.
 *
 * Projects created before slugs existed get one lazily: `GET /api/projects` (without `lite=1` or
 * `sidebar=1`) backfills a slug for every row it lists. Until that has happened a by-slug lookup
 * cannot find such a project, and a 404 from `GET /api/projects/:slug` then means "not yet
 * addressable", not "does not exist". The route reports the difference so a client (the MCP's
 * `projectIdForSlug`) can fall back to listing, which performs the backfill, only when it is the
 * legacy case and not on every miss.
 */
export function slugBackfillPendingFilter(
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
): Record<string, unknown> {
  const noSlug = { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] };
  const tenant = allowLegacyByUserId
    ? { $or: [{ orgId }, { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] }] }
    : { orgId };
  return { $and: [tenant, noSlug, { isDeleted: { $ne: true } }] };
}
