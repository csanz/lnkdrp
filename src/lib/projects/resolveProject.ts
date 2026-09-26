/**
 * "Which room is this caller talking about?" — one id-or-slug read, bounded by the visibility clause.
 *
 * `/api/projects/:idOrSlug` has always accepted either form, and the routes that hang off it
 * (`/members`, `/lock-review`) have to answer exactly as it does or they become the oracle the rest
 * of the feature removes: a locked room a caller is not in is absent, so a miss here is the same 404
 * as an id that never existed (docs/prds/lnkdrp-locked-projects.md, decision 8).
 *
 * It exists as a helper rather than a third copy of the same twelve lines for the reason the whole
 * feature is built on: every project read for a person goes through `src/lib/projects/scope.ts`, and
 * `tests/lib/lockedProjectSurfaces.test.ts` counts the call sites. One shared read is one line for
 * that contract to pin instead of three.
 */
import { Types } from "mongoose";

import type { Actor } from "@/lib/gating/actor";
import { ProjectModel } from "@/lib/models/Project";
import { liveProjectByIdMatch, liveProjectBySlugMatch } from "@/lib/projects/scope";

/** The fields every caller of this helper needs; `select` widens it. */
const BASE_SELECT = {
  _id: 1,
  orgId: 1,
  userId: 1,
  name: 1,
  slug: 1,
  shareId: 1,
  shareEnabled: 1,
  visibility: 1,
  lockedAt: 1,
  lockedByUserId: 1,
  isRequest: 1,
  requestUploadToken: 1,
} as const;

export type ResolvedProject = {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  userId?: Types.ObjectId | null;
  name?: string | null;
  slug?: string | null;
  shareId?: string | null;
  shareEnabled?: unknown;
  visibility?: unknown;
  lockedAt?: unknown;
  lockedByUserId?: unknown;
  isRequest?: unknown;
  requestUploadToken?: unknown;
};

/**
 * Resolve a project by id or slug for this actor, or `null`.
 *
 * `null` means "answer 404", always with the same body: it covers a room that does not exist, a
 * deleted one, one in another workspace and a locked one this person is not in, and those four must
 * not be distinguishable. Slugs are `slugify(name)` and unique per workspace, so they are guessable
 * by construction, which is why the slug path carries the clause as firmly as the id path.
 */
export async function resolveProjectForActor(params: {
  actor: Actor;
  /** The raw `[projectSlug]` path segment: a 24-hex id or a slug. */
  param: string;
  request?: Request;
  /** Extra fields to select, merged over the base set. */
  select?: Record<string, 0 | 1>;
}): Promise<ResolvedProject | null> {
  const param = (params.param ?? "").trim();
  if (!param) return null;
  const { actor } = params;
  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const byId = Types.ObjectId.isValid(param) && /^[0-9a-f]{24}$/i.test(param);

  const match = byId
    ? await liveProjectByIdMatch(
        new Types.ObjectId(param),
        orgId,
        legacyUserId,
        allowLegacyByUserId,
        actor.userId,
        params.request,
      )
    : // Stored slugs are lower-case (`slugify`), and the unique index is an exact match.
      await liveProjectBySlugMatch(
        param.toLowerCase(),
        orgId,
        legacyUserId,
        allowLegacyByUserId,
        actor.userId,
        params.request,
      );

  const row = (await ProjectModel.findOne(match)
    .select({ ...BASE_SELECT, ...(params.select ?? {}) })
    .lean()) as ResolvedProject | null;
  return row ?? null;
}

/** True when this row is a private data room. A row with no `visibility` field is open, by design. */
export function isLockedProject(project: { visibility?: unknown } | null | undefined): boolean {
  return project?.visibility === "locked";
}

/**
 * True when this row is a request inbox, by either of the two things that make one.
 *
 * A request inbox can never be locked (decision 10): it is a recipient-facing surface gated by a
 * capability token, and a member clause anywhere near it breaks inbound uploads.
 */
export function isRequestProject(
  project: { isRequest?: unknown; requestUploadToken?: unknown } | null | undefined,
): boolean {
  if (!project) return false;
  if (project.isRequest === true) return true;
  const token = project.requestUploadToken;
  return typeof token === "string" && token.trim().length > 0;
}
