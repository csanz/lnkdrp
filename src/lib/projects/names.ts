/**
 * "What is this room called?" — the one answer, and it is `null` for a room the reader may not see
 * (docs/prds/lnkdrp-locked-projects.md, decision 14).
 *
 * A locked room's NAME is a leak on its own. "Acme / Project Nightingale" in a feed row, an email
 * footer, a contact's source list or a Slack message tells a non-member that the acquisition exists,
 * which is most of what the lock is for. About a dozen queries across `src/` existed only to turn a
 * project id into a name, each one a bare `_id`-in-a-list read of the projects collection, and three of
 * them carried no tenancy clause at all: the activity feed, `sendNotificationEmails.ts` and
 * `visitBriefs.ts`'s `findById`. So a cross-tenant name leak rides along in the same change as the
 * lock one, because both are the same missing WHERE clause.
 *
 * Callers render their own fallback for a `null`. The user-facing words are "a private data room"
 * where the reader is a workspace member who might wonder, and the ordinary "Data room" where the
 * name was never load-bearing.
 */
import { Types } from "mongoose";

import { ProjectModel } from "@/lib/models/Project";
import { projectGrantIds, projectVisibilityClause } from "@/lib/projects/lockScope";

/** Only well-formed, distinct ids, so a caller can pass a raw list of whatever it has in hand. */
function normaliseIds(ids: ReadonlyArray<unknown>): Types.ObjectId[] {
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const raw of ids) {
    if (!raw) continue;
    const key = String(raw);
    if (!Types.ObjectId.isValid(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(new Types.ObjectId(key));
  }
  return out;
}

/**
 * Names for these project ids, in this workspace, as this person may see them.
 *
 * Every requested id gets an entry: a trimmed name for a room the viewer may see, and `null` for a
 * locked room they hold no grant for, for a room in another workspace, and for an id that names
 * nothing. Those four are deliberately indistinguishable here for the same reason the by-id routes
 * answer one 404 for all of them (decision 8) — a caller that could tell "hidden" from "gone" would
 * put the difference on a page.
 *
 * `isDeleted` is excluded, which tightens two of the callers this replaces. That is on purpose and it
 * is close to a no-op: the user-facing `DELETE /api/projects/:id` is a hard delete, so `isDeleted` is
 * written only by the admin data routes and the workspace sweep, and a room an operator has retired
 * has no name worth putting in an email.
 */
export async function projectNamesFor(params: {
  orgId: Types.ObjectId | string;
  ids: ReadonlyArray<unknown>;
  viewerUserId: Types.ObjectId | string;
  request?: Request;
}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = normaliseIds(params.ids);
  for (const id of ids) out.set(String(id), null);
  if (!ids.length) return out;

  const orgKey = String(params.orgId);
  if (!Types.ObjectId.isValid(orgKey)) return out;

  const rows = (await ProjectModel.find({
    _id: { $in: ids },
    orgId: new Types.ObjectId(orgKey),
    isDeleted: { $ne: true },
    // Into `$and`, never as a sibling `$or` key: a second `$or` in one object literal silently
    // replaces the first, which is the trap `tests/lib/liveProjectScope.test.ts` exists for.
    $and: [projectVisibilityClause(await projectGrantIds(orgKey, params.viewerUserId, params.request))],
  })
    .select({ _id: 1, name: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; name?: unknown }>;

  for (const row of rows) {
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
    out.set(String(row._id), name);
  }
  return out;
}

/**
 * {@link projectNamesFor} for the callers that hold exactly one id.
 *
 * Several of the hydrations this replaces were a single `findById`, and a helper that only takes a
 * list invites those to keep their own one-row query instead.
 */
export async function projectNameFor(params: {
  orgId: Types.ObjectId | string;
  id: unknown;
  viewerUserId: Types.ObjectId | string;
  request?: Request;
}): Promise<string | null> {
  if (!params.id) return null;
  const names = await projectNamesFor({
    orgId: params.orgId,
    ids: [params.id],
    viewerUserId: params.viewerUserId,
    request: params.request,
  });
  return names.get(String(params.id)) ?? null;
}
