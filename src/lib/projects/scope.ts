/**
 * The one definition of "a project that counts" for a workspace, and of "a project this person may
 * see".
 *
 * The plan check and the project list each had their own copy of this filter, and they drifted: a
 * workspace showing one project was refused a second with "used: 2, max: 1" (2026-09-18), so the
 * cap blocked a slot the owner could not see. Both still build their query here.
 *
 * They no longer build the SAME query, and the divergence is deliberate and one-directional
 * (docs/prds/lnkdrp-locked-projects.md, decision 29). The two agreed in September because the list
 * was the truth. Now a locked project is a row the caller may not be allowed to see, and a cap that
 * skipped those would make the Free plan unlimited by locking. So:
 *
 * - {@link allProjectsFilter} counts every live project in the workspace, lock or no lock, and is
 *   what `src/lib/billing/planLimits.ts` uses. It is the lock-free half on purpose.
 * - {@link liveProjectFilter} is that plus the caller's visibility clause, and is what every list
 *   uses.
 *
 * The consequence is a count oracle: a non-member can tell from "at your limit" that rooms exist
 * they cannot see. That is accepted and mitigated by copy rather than by hiding, because the
 * alternative is a cap that a lock switches off.
 *
 * Request repos are not projects in this sense: they are a separate feature with their own list,
 * they are recognised either by `isRequest` or by carrying an upload token, and they can never be
 * locked (decision 10), so no clause here has to make room for one.
 */
import type { Types } from "mongoose";

import { projectGrantIds, projectVisibilityClause } from "@/lib/projects/lockScope";

/**
 * Every live, non-request project in the workspace, with no visibility clause of any kind.
 *
 * Two callers and no more: {@link liveProjectFilter}, which adds the clause, and the plan cap, which
 * must not. Anything else that reads projects for a person wants {@link liveProjectFilter}.
 */
export function allProjectsFilter(orgId: Types.ObjectId): Record<string, unknown> {
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
 * Mongo conditions for the projects this person may see in this workspace.
 *
 * `viewerUserId` is required, and it is an id rather than a precomputed set of hidden ids because an
 * id is hard to invent at a call site while `[]` compiles and fails open. Pass `request` wherever
 * one is in hand: it memoises the grant read for the rest of that request.
 */
export async function liveProjectFilter(
  orgId: Types.ObjectId,
  viewerUserId: Types.ObjectId | string,
  request?: Request,
): Promise<Record<string, unknown>> {
  const filter = allProjectsFilter(orgId);
  (filter.$and as Array<Record<string, unknown>>).push(
    projectVisibilityClause(await projectGrantIds(orgId, viewerUserId, request)),
  );
  return filter;
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
 *
 * The visibility clause lands in `$and` and NEVER as a second top-level `$or` key. In a JS object
 * literal a second `$or` replaces the first, so writing it as a sibling would delete the legacy
 * tenancy alternative and widen the query while reading as though it narrowed it. That is the exact
 * bug `tests/lib/liveProjectScope.test.ts` was written to pin, and
 * `tests/lib/lockedProjectScope.test.ts` pins it again for the clause.
 */
export async function liveProjectByIdMatch(
  projectId: Types.ObjectId,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
  viewerUserId: Types.ObjectId | string,
  request?: Request,
): Promise<Record<string, unknown>> {
  const notDeleted = { isDeleted: { $ne: true } };
  const visible = { $and: [projectVisibilityClause(await projectGrantIds(orgId, viewerUserId, request))] };
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        ...visible,
        $or: [
          { _id: projectId, orgId },
          { _id: projectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: projectId, orgId, ...notDeleted, ...visible };
}

/**
 * The by-slug counterpart of {@link liveProjectByIdMatch}: the same tenancy, deletion and
 * visibility bounds, keyed on the workspace-unique `slug` instead of `_id`.
 *
 * Slugs are unique per workspace (`{ orgId, slug }`) and, for projects that predate workspaces,
 * per owner (`{ userId, slug }`), so the two alternatives of the legacy branch can never both
 * match a different row. The exact-match on `slug` is deliberate: the route lower-cases the
 * caller's slug before it gets here, and every stored slug is lower-case (`slugify`), so a regex
 * would only buy a collection scan.
 *
 * This path carries the clause for a reason the by-id path does not: slugs are `slugify(name)` and
 * unique per workspace, so they are guessable by construction. A 403 here, or any answer that
 * differed from the answer for a slug nobody has ever used, would be a sentence reading "a private
 * room with this name exists" (decision 8).
 */
export async function liveProjectBySlugMatch(
  slug: string,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
  viewerUserId: Types.ObjectId | string,
  request?: Request,
): Promise<Record<string, unknown>> {
  const notDeleted = { isDeleted: { $ne: true } };
  const visible = { $and: [projectVisibilityClause(await projectGrantIds(orgId, viewerUserId, request))] };
  return allowLegacyByUserId
    ? {
        ...notDeleted,
        ...visible,
        $or: [
          { slug, orgId },
          { slug, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { slug, orgId, ...notDeleted, ...visible };
}

/**
 * True when the workspace still holds a live project THIS CALLER MAY SEE with no stored slug.
 *
 * Projects created before slugs existed get one lazily: `GET /api/projects` (without `lite=1` or
 * `sidebar=1`) backfills a slug for every row it lists. Until that has happened a by-slug lookup
 * cannot find such a project, and a 404 from `GET /api/projects/:slug` then means "not yet
 * addressable", not "does not exist". The route reports the difference so a client (the MCP's
 * `projectIdForSlug`) can fall back to listing, which performs the backfill, only when it is the
 * legacy case and not on every miss.
 *
 * The clause is on this probe too, because `reason: "slug_backfill_pending"` is otherwise a second
 * answer shape a caller can compare against: a locked room with no slug would make this 404 differ
 * from the 404 for a slug that has never existed, which is the oracle decision 8 removes.
 */
export async function slugBackfillPendingFilter(
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
  viewerUserId: Types.ObjectId | string,
  request?: Request,
): Promise<Record<string, unknown>> {
  const noSlug = { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] };
  const tenant = allowLegacyByUserId
    ? { $or: [{ orgId }, { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] }] }
    : { orgId };
  return {
    $and: [
      tenant,
      noSlug,
      { isDeleted: { $ne: true } },
      projectVisibilityClause(await projectGrantIds(orgId, viewerUserId, request)),
    ],
  };
}
