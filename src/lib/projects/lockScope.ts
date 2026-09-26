/**
 * Locked projects (docs/prds/lnkdrp-locked-projects.md, decisions 5, 6 and 7): the project-shaped
 * twin of `src/lib/docs/visibility.ts`.
 *
 * A project with `visibility: "locked"` is a private data room. For a workspace member who holds no
 * grant it is not restricted, it is absent: no row in any list, 404 by id and by slug, and no name
 * anywhere. There is no bypass for an owner or an admin (decision 21); the clause below has no role
 * term at all, and the only way into a room is a `ProjectMembership` row the room's members can see.
 *
 * Every project-shaped read spreads {@link projectVisibilityClause} rather than restating the rule,
 * so a new listing cannot forget it, and `tests/lib/lockedProjectSurfaces.test.ts` pins every call
 * site to one of three answers.
 *
 * Cost: this copies the caching in `src/lib/gating/actor.ts` deliberately, so the steady state is
 * zero extra queries on a cache hit and one tiny indexed `_id`-projected read on a miss. A
 * workspace that holds no locked project has no `ProjectMembership` rows at all, which is what
 * makes the clause inert there.
 */
import { Types } from "mongoose";

import { debugError } from "@/lib/debug";
import {
  ProjectMembershipModel,
  type ProjectMembershipRole,
  type ProjectMembershipVia,
} from "@/lib/models/ProjectMembership";
import { ProjectModel } from "@/lib/models/Project";

/**
 * The visibility clause, spread into the `$and` of every project-shaped filter.
 *
 * `$ne: "locked"` is a `$ne` ON PURPOSE. Every project row in the database today has no
 * `visibility` field at all, so an equality on `"workspace"` would match none of them and hide the
 * entire product's existing data behind a feature nobody has turned on yet. That mistake already
 * happened once in this collection: `db/migration/20260925_0003_projects_live_unique_names.mjs`
 * exists because `isDeleted: false` is an equality that rows without the field escaped. Nobody may
 * "optimise" this into `visibility: "workspace"`.
 *
 * The second arm is what lets a member back in: their own grant ids, by `_id`. With no grants it is
 * `{ $in: [] }`, which matches nothing and costs nothing, and the `$or` still admits every
 * unlocked row.
 */
export function projectVisibilityClause(grantIds: Types.ObjectId[]): {
  $or: Array<{ visibility: { $ne: "locked" } } | { _id: { $in: Types.ObjectId[] } }>;
} {
  return { $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: grantIds } }] };
}

/**
 * "This document's home is a room you cannot see" — the one definition of that rule.
 *
 * Keyed on the document's HOME and not on its membership (decision 12), which is the same rule
 * `canContain()` and Slack's `routingFor()` already use: a document that also lives in an open
 * project stays visible there, because the alternative lets one member silently withdraw shared
 * documents from the workspace by locking a second room.
 *
 * Returns `{}` when nothing is hidden, so a workspace with no locked project adds no Mongo term at
 * all and every document filter stays byte-identical to what it was before this feature existed.
 *
 * `fieldPrefix` is for an aggregate that has already `$lookup`ed the document under a name — the
 * share-link search joins it as `doc`, so it asks for `lockedHomeExclusion(hidden, "doc")`. It is a
 * parameter rather than a second function because the rule has to have exactly one definition: a
 * `$nor` rewritten by hand for one pipeline is the copy that keeps the first arm and forgets the
 * second, and the second arm is the subtle one.
 */
export function lockedHomeExclusion(hiddenIds: Types.ObjectId[], fieldPrefix = ""): Record<string, unknown> {
  if (!hiddenIds.length) return {};
  const at = fieldPrefix ? `${fieldPrefix}.` : "";
  return {
    $nor: [
      { [`${at}primaryProjectId`]: { $in: hiddenIds } },
      { [`${at}primaryProjectId`]: null, [`${at}projectIds`]: { $in: hiddenIds } },
    ],
  };
}

/**
 * {@link lockedHomeExclusion} as `$expr` terms, for a `$lookup` pipeline that can only speak in
 * aggregation expressions.
 *
 * Two terms rather than one, one per arm of the `$nor`, so the pair reads as the same rule the plain
 * form states. Spread into the `$and` a `$lookup`'s `$expr` already carries, beside the containment
 * twin `{ $ne: ["$visibility", "project"] }` that lives next to it in
 * `src/app/api/dashboard/stats/route.ts`. Returns `[]` when nothing is hidden, so the pipeline it
 * goes into is unchanged in a workspace with no locked room.
 *
 * `$ifNull` on both fields is load-bearing: a document that predates `primaryProjectId` has no such
 * path at all, and `$in` against a missing value is not the same question as `$in` against `null`.
 */
export function lockedHomeExclusionExpr(hiddenIds: Types.ObjectId[]): Record<string, unknown>[] {
  if (!hiddenIds.length) return [];
  const primary = { $ifNull: ["$primaryProjectId", null] };
  return [
    { $not: [{ $in: [primary, hiddenIds] }] },
    {
      $not: [
        {
          $and: [
            { $eq: [primary, null] },
            { $gt: [{ $size: { $setIntersection: [{ $ifNull: ["$projectIds", []] }, hiddenIds] } }, 0] },
          ],
        },
      ],
    },
  ];
}

/**
 * Short-lived in-memory grant cache, in the shape of `MEMBERSHIP_EXISTS_CACHE_TTL_MS` in
 * `src/lib/gating/actor.ts`.
 *
 * Tradeoff, said out loud: a grant added or revoked in the last ten seconds may still be served
 * from here, and `projectMembershipChanged()` only clears the cache in THIS process, so on a
 * multi-instance deploy the other instances keep serving their own entries until their TTL expires.
 * Ten seconds is the same window the workspace membership check already accepts for the same
 * reason, and it shortens rather than closes the window, which is why the invalidator is a
 * companion to the short TTL and not a substitute for it.
 */
const GRANT_CACHE_TTL_MS = 10_000;
const GRANT_CACHE_MAX = 500;
let grantCache: Map<string, { at: number; ids: Types.ObjectId[] }> | null = null;

/**
 * Per-`Request` memo, in the shape of `ACTOR_CACHE` in `src/lib/gating/actor.ts`.
 *
 * A route that lists projects and then lists documents asks this question two or three times on one
 * request, and the memo makes it pay once. It also makes the answer CONSISTENT within a request: a
 * TTL that expired between the project filter and the document filter would otherwise let one
 * request build two filters from two different grant sets.
 */
const GRANT_MEMO = new WeakMap<Request, Map<string, Types.ObjectId[]>>();

function grantCacheKey(orgId: string, userId: string): string {
  return `org:${orgId}:user:${userId}`;
}

function getCachedGrants(key: string): Types.ObjectId[] | null {
  grantCache = grantCache ?? new Map();
  const e = grantCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > GRANT_CACHE_TTL_MS) {
    grantCache.delete(key);
    return null;
  }
  return e.ids;
}

function setCachedGrants(key: string, ids: Types.ObjectId[]): void {
  grantCache = grantCache ?? new Map();
  grantCache.set(key, { at: Date.now(), ids });
  // Best-effort bound; drop the oldest-ish entry (O(n), rare), exactly as the actor cache does.
  if (grantCache.size > GRANT_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of grantCache.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) grantCache.delete(oldestKey);
  }
}

/**
 * The workspace's locked project ids, cached the same way and for the same reason.
 *
 * `hiddenProjectIds` is asked on the hot paths now — the document list, the document page, the
 * sidebar, the dashboard, starred, the tag pages — and more than once on some of them, so without
 * this every one of those requests would pay a `projects` read to be told what it was told a moment
 * ago. This answer is per WORKSPACE rather than per person (the grants are the per-person half), so
 * one entry serves every member, which is what makes the cache worth having at all.
 *
 * The same ten seconds and the same honest limitation as the grant cache: a room locked or unlocked
 * in the last ten seconds may still be answered from here, `projectVisibilityChanged()` shortens
 * that window in this process only, and the other instances wait out their own TTL. On a LOCK the
 * staleness runs the wrong way — a non-member keeps seeing the room for up to ten seconds — which is
 * why the invalidator is a companion to the short TTL rather than a substitute for it.
 */
const LOCKED_IDS_CACHE_TTL_MS = 10_000;
const LOCKED_IDS_CACHE_MAX = 500;
let lockedIdsCache: Map<string, { at: number; ids: Types.ObjectId[] }> | null = null;
const LOCKED_IDS_MEMO = new WeakMap<Request, Map<string, Types.ObjectId[]>>();

function getCachedLockedIds(orgKey: string): Types.ObjectId[] | null {
  lockedIdsCache = lockedIdsCache ?? new Map();
  const e = lockedIdsCache.get(orgKey);
  if (!e) return null;
  if (Date.now() - e.at > LOCKED_IDS_CACHE_TTL_MS) {
    lockedIdsCache.delete(orgKey);
    return null;
  }
  return e.ids;
}

function setCachedLockedIds(orgKey: string, ids: Types.ObjectId[]): void {
  lockedIdsCache = lockedIdsCache ?? new Map();
  lockedIdsCache.set(orgKey, { at: Date.now(), ids });
  // Best-effort bound, the same shape as the grant cache above.
  if (lockedIdsCache.size > LOCKED_IDS_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of lockedIdsCache.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) lockedIdsCache.delete(oldestKey);
  }
}

/**
 * Forget which of a workspace's rooms are locked.
 *
 * Called immediately after a write that changes a project's `visibility`, and after one that removes
 * a locked room outright, for the same reason {@link projectMembershipChanged} exists next door: a
 * lock is something the person who just set it expects to be true when the page repaints.
 */
export function projectVisibilityChanged(params: { orgId: string | Types.ObjectId }): void {
  try {
    lockedIdsCache?.delete(String(params.orgId));
  } catch {
    // A cache that cannot be cleared must not fail the write that cleared it.
  }
}

/**
 * Forget the cached grant set for one (workspace, person).
 *
 * Every route that adds, revokes or seats a grant calls this immediately after the write, for the
 * same reason `membershipChanged()` exists: for a read, ten seconds of staleness is a fair trade,
 * and for "you are now in this room" or "you are no longer in this room" it is not. Somebody who
 * has just been removed must not keep reading the room while the page they are on repaints.
 */
export function projectMembershipChanged(params: {
  orgId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
}): void {
  try {
    grantCache?.delete(grantCacheKey(String(params.orgId), String(params.userId)));
  } catch {
    // A cache that cannot be cleared must not fail the write that cleared it.
  }
}

/**
 * The ids of the locked projects this person holds a live grant for, in this workspace.
 *
 * One indexed, `_id`-projected read against `{ orgId, userId, isDeleted }`, bounded by how many
 * locked rooms one person can be in. Pass the `Request` wherever one is in hand so the per-request
 * memo can do its job; without it the ten-second cache still applies.
 *
 * Fails CLOSED, and that direction is the whole reason this can be a soft failure at all: these ids
 * only ever WIDEN what the caller sees, so an empty answer hides a room from somebody entitled to
 * it and can never reveal one. A read error therefore returns `[]` rather than refusing the
 * request. `hiddenProjectIds` below is the mirror image and must not do this.
 */
export async function projectGrantIds(
  orgId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  request?: Request,
): Promise<Types.ObjectId[]> {
  const orgKey = String(orgId);
  const userKey = String(userId);
  if (!Types.ObjectId.isValid(orgKey) || !Types.ObjectId.isValid(userKey)) return [];
  const key = grantCacheKey(orgKey, userKey);

  if (request) {
    const memo = GRANT_MEMO.get(request);
    const hit = memo?.get(key);
    if (hit) return hit;
  }

  const cached = getCachedGrants(key);
  if (cached) {
    if (request) rememberOnRequest(request, key, cached);
    return cached;
  }

  // No connection means no grants: a filter built while the database is unreachable hides locked
  // rooms rather than revealing them, and the project query this clause is being built for is about
  // to fail on its own anyway. Every route awaits `connectMongo()` before it builds a filter, so in
  // production this is the disconnected case and not the ordinary one.
  if (ProjectMembershipModel.db?.readyState !== 1) return [];

  let ids: Types.ObjectId[] = [];
  try {
    const rows = (await ProjectMembershipModel.find({
      orgId: new Types.ObjectId(orgKey),
      userId: new Types.ObjectId(userKey),
      isDeleted: { $ne: true },
    })
      .select({ projectId: 1 })
      .lean()) as Array<{ projectId?: Types.ObjectId }>;
    ids = rows.map((r) => r.projectId).filter((id): id is Types.ObjectId => Boolean(id));
    setCachedGrants(key, ids);
  } catch (err) {
    // Not cached: a blip must not hide somebody's room for the next ten seconds of requests.
    debugError(1, "[lockScope] grant read failed", err instanceof Error ? err.message : String(err));
    return [];
  }

  if (request) rememberOnRequest(request, key, ids);
  return ids;
}

function rememberOnRequest(request: Request, key: string, ids: Types.ObjectId[]): void {
  const memo = GRANT_MEMO.get(request) ?? new Map<string, Types.ObjectId[]>();
  memo.set(key, ids);
  GRANT_MEMO.set(request, memo);
}

/**
 * How many locked rooms one workspace may hold before {@link hiddenProjectIds} refuses to answer.
 *
 * The same ceiling `containedDocIds` uses, and far above any real workspace: the cap exists to stop
 * an unbounded read, not to express a product limit.
 */
export const HIDDEN_PROJECT_IDS_CAP = 5000;

/** Thrown when a workspace holds more locked projects than {@link HIDDEN_PROJECT_IDS_CAP}. */
export class LockedProjectCapExceededError extends Error {
  constructor(readonly orgId: string) {
    super(`Too many locked projects in workspace ${orgId} to build an exclusion safely`);
    this.name = "LockedProjectCapExceededError";
  }
}

/**
 * The workspace's locked project ids MINUS this caller's grants: the set that has to be excluded in
 * the places where the exclusion lands on somebody else's field as a `$nin` rather than on `_id`.
 *
 * Returns an empty array when the workspace holds no locked project, so every filter that consumes
 * it adds no Mongo term at all.
 *
 * Fails CLOSED, unlike {@link projectGrantIds}, and the asymmetry is the point (decision 6). A
 * `$nin` against a truncated or empty array matches EVERYTHING, so the naive version of this cap is
 * a total leak wearing the costume of a slow page. Past the cap, and on a read error, this refuses
 * the listing and says so rather than handing back a short array that reads as "nothing to hide".
 * `containedDocIds` truncates silently and is defensible there because containment is discovery;
 * it is not defensible for access.
 */
export async function hiddenProjectIds(
  orgId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  request?: Request,
): Promise<Types.ObjectId[]> {
  const orgKey = String(orgId);
  if (!Types.ObjectId.isValid(orgKey)) return [];

  const locked = await lockedProjectIds(orgKey, request);
  if (!locked.length) return [];

  const grants = new Set((await projectGrantIds(orgKey, userId, request)).map((id) => String(id)));
  return locked.filter((id) => !grants.has(String(id)));
}

/**
 * Every locked project id in one workspace, cached per request and then for ten seconds.
 *
 * Split out of {@link hiddenProjectIds} because the answer has nothing to do with who is asking: the
 * caller's grants are subtracted afterwards, so one cache entry serves every member of the workspace.
 *
 * It refuses past the cap rather than truncating, and it does NOT cache a failure: a read error
 * propagates, so the listing that asked is refused rather than served from a short array. A `$nin`
 * against a truncated or empty array matches everything, which is the leak decision 6 exists to stop.
 */
async function lockedProjectIds(orgKey: string, request?: Request): Promise<Types.ObjectId[]> {
  if (request) {
    const memo = LOCKED_IDS_MEMO.get(request);
    const hit = memo?.get(orgKey);
    if (hit) return hit;
  }
  const cached = getCachedLockedIds(orgKey);
  if (cached) {
    if (request) rememberLockedOnRequest(request, orgKey, cached);
    return cached;
  }

  /**
   * One more than the cap, so a workspace sitting exactly on the ceiling is answered and the one past
   * it is detected rather than quietly trimmed.
   *
   * The ceiling is an option on the query rather than a chained `.limit()`, deliberately: this read
   * exists to be bounded, so the bound belongs beside the filter it bounds rather than three lines
   * below it, and the chain is then the same `.select().lean()` that `projectGrantIds` above uses.
   */
  const rows = (await ProjectModel.find(
    {
      orgId: new Types.ObjectId(orgKey),
      visibility: "locked",
      isDeleted: { $ne: true },
    },
    null,
    { limit: HIDDEN_PROJECT_IDS_CAP + 1 },
  )
    .select({ _id: 1 })
    .lean()) as Array<{ _id: Types.ObjectId }>;

  if (rows.length > HIDDEN_PROJECT_IDS_CAP) {
    const err = new LockedProjectCapExceededError(orgKey);
    // Worth a line at any debug level: a workspace in this state is serving refusals, and the
    // alternative to the alarm is a page that looks slow while it leaks. Not cached, so the next
    // request asks again instead of inheriting ten seconds of refusal from this one.
    console.error(`[lockScope] ${err.message}`);
    throw err;
  }

  const ids = rows.map((r) => r._id);
  setCachedLockedIds(orgKey, ids);
  if (request) rememberLockedOnRequest(request, orgKey, ids);
  return ids;
}

/** The per-request half, in the shape `rememberOnRequest` uses for grants. */
function rememberLockedOnRequest(request: Request, orgKey: string, ids: Types.ObjectId[]): void {
  const memo = LOCKED_IDS_MEMO.get(request) ?? new Map<string, Types.ObjectId[]>();
  memo.set(orgKey, ids);
  LOCKED_IDS_MEMO.set(request, memo);
}

/**
 * {@link hiddenProjectIds} followed by {@link lockedHomeExclusion}, which is the pair every document
 * surface needs and nothing else ever needs separately.
 *
 * It exists as one call because the two-step version has a failure mode that compiles: a caller who
 * reads the hidden ids and then forgets the second line gets a filter with no exclusion in it and no
 * complaint from anybody. Roughly thirty call sites across `src/` ask this question, so the shape of
 * the question is worth one export.
 *
 * It does NOT catch {@link LockedProjectCapExceededError}, on purpose. Past the cap the honest answer
 * is a refused listing, because a `$nor` against a short array matches everything and a caught error
 * would turn a slow page into a silent total leak.
 */
export async function lockedHomeExclusionFor(
  orgId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  request?: Request,
): Promise<Record<string, unknown>> {
  return lockedHomeExclusion(await hiddenProjectIds(orgId, userId, request));
}

/**
 * How many people one locked room may hold (decision 23).
 *
 * A private data room with two hundred people in it is a workspace, not a room, and the cap exists
 * so the roster read, the notification audience and the members panel all stay one small query.
 */
export const LOCKED_ROOM_MEMBER_CAP = 200;

/** One live grant, as the roster and the audience read it. */
export type ProjectGrantRow = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  role: ProjectMembershipRole;
  via: ProjectMembershipVia;
  addedByUserId: Types.ObjectId | null;
  reason: string;
  createdDate: Date | null;
};

/**
 * The live roster of one room, oldest grant first.
 *
 * Capped one past {@link LOCKED_ROOM_MEMBER_CAP} so a room that somehow holds more than the cap is
 * visible as such to the caller rather than silently trimmed to look full.
 */
export async function projectGrants(params: {
  orgId: Types.ObjectId | string;
  projectId: Types.ObjectId | string;
}): Promise<ProjectGrantRow[]> {
  const orgKey = String(params.orgId);
  const projectKey = String(params.projectId);
  if (!Types.ObjectId.isValid(orgKey) || !Types.ObjectId.isValid(projectKey)) return [];
  const rows = (await ProjectMembershipModel.find({
    orgId: new Types.ObjectId(orgKey),
    projectId: new Types.ObjectId(projectKey),
    isDeleted: { $ne: true },
  })
    .select({ userId: 1, role: 1, via: 1, addedByUserId: 1, reason: 1, createdDate: 1 })
    .sort({ createdDate: 1, _id: 1 })
    .limit(LOCKED_ROOM_MEMBER_CAP + 1)
    .lean()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    _id: r._id as Types.ObjectId,
    userId: r.userId as Types.ObjectId,
    role: (r.role === "reader" ? "reader" : "editor") as ProjectMembershipRole,
    via: (r.via === "creator" || r.via === "break_glass" ? r.via : "added") as ProjectMembershipVia,
    addedByUserId: (r.addedByUserId as Types.ObjectId | null) ?? null,
    reason: typeof r.reason === "string" ? r.reason : "",
    createdDate: r.createdDate instanceof Date ? r.createdDate : null,
  }));
}

/**
 * Seat one person in one room, reviving the grant they already have rather than inserting a second.
 *
 * The `{ projectId, userId }` index is unique, so a re-add is an update: a revoked row keeps its
 * history (`revokedAt` says when they were last removed) and comes back as a live grant. That is
 * also why this is an `updateOne` with an upsert rather than a `create` in a try/catch — the second
 * shape races itself when two people add the same person at once and answers a duplicate-key error
 * where the honest answer is "they are already in".
 *
 * Returns whether the row was newly seated, so the caller can skip the feed row and the email for a
 * grant that already existed.
 */
export async function grantProjectMembership(params: {
  orgId: Types.ObjectId | string;
  projectId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  role: ProjectMembershipRole;
  via: ProjectMembershipVia;
  addedByUserId?: Types.ObjectId | string | null;
  reason?: string;
}): Promise<{ added: boolean }> {
  const orgId = new Types.ObjectId(String(params.orgId));
  const projectId = new Types.ObjectId(String(params.projectId));
  const userId = new Types.ObjectId(String(params.userId));
  const addedBy = params.addedByUserId ? new Types.ObjectId(String(params.addedByUserId)) : null;

  const existing = (await ProjectMembershipModel.findOne({ projectId, userId })
    .select({ isDeleted: 1 })
    .lean()) as { isDeleted?: unknown } | null;
  const wasLive = Boolean(existing) && existing?.isDeleted !== true;

  await ProjectMembershipModel.updateOne(
    { projectId, userId },
    {
      $set: {
        orgId,
        role: params.role,
        via: params.via,
        addedByUserId: addedBy,
        reason: (params.reason ?? "").trim().slice(0, 500),
        isDeleted: false,
        revokedAt: null,
      },
    },
    { upsert: true },
  );
  // "You are now in this room" is not something to learn ten seconds late, and the caller usually
  // renders the room immediately after this (see `projectMembershipChanged`).
  projectMembershipChanged({ orgId, userId });
  return { added: !wasLive };
}

/**
 * The ONE writer that clears grants (decision 4).
 *
 * Four places have to clear them — the workspace-membership revoke route, `.../leave`,
 * `src/lib/accounts/purge.ts` and the workspace-delete sweep — and four hand-written updates is how
 * one of them ends up setting `isDeleted` without `revokedAt`, or clearing a person's grants in
 * every workspace instead of one. `tests/lib/lockedProjectLifecycle.test.ts` greps those files for
 * this function precisely because the type-checker cannot see a place that forgot to call it.
 *
 * Soft, not hard: the row keeps `revokedAt` so "who has ever been in this room" stays answerable,
 * which is the question a compliance request opens with. `src/app/api/org-invites/claim/route.ts`
 * revives a revoked `OrgMembership` with the invite's role and must never touch these rows, so a
 * removed person who is re-invited comes back into the workspace with no rooms.
 *
 * `userId` omitted means every grant in the workspace, which is what the workspace-delete sweep
 * needs: the rooms are going with the workspace, and a grant into a room that no longer exists is a
 * row that would come back to life if the workspace were ever restored.
 */
export async function revokeProjectGrants(params: {
  orgId: string | Types.ObjectId;
  userId?: string | Types.ObjectId | null;
  /** Only these rooms; omitted, every room in the workspace. */
  projectIds?: ReadonlyArray<string | Types.ObjectId>;
  now?: Date;
}): Promise<number> {
  const orgKey = String(params.orgId);
  if (!Types.ObjectId.isValid(orgKey)) return 0;
  const userKey = params.userId ? String(params.userId) : "";
  if (userKey && !Types.ObjectId.isValid(userKey)) return 0;
  const projectIds = (params.projectIds ?? [])
    .map((id) => String(id))
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const now = params.now instanceof Date ? params.now : new Date();

  const filter: Record<string, unknown> = {
    orgId: new Types.ObjectId(orgKey),
    isDeleted: { $ne: true },
    ...(userKey ? { userId: new Types.ObjectId(userKey) } : {}),
    ...(projectIds.length ? { projectId: { $in: projectIds } } : {}),
  };

  // Whose caches to clear, read BEFORE the write: after it there is no live row left to tell us who
  // was affected, and a stale grant set is exactly the ten seconds of access this revoke exists to
  // end.
  const affected = userKey
    ? [userKey]
    : ((await ProjectMembershipModel.find(filter).select({ userId: 1 }).lean()) as Array<{ userId?: Types.ObjectId }>)
        .map((r) => (r.userId ? String(r.userId) : ""))
        .filter(Boolean);

  const res = await ProjectMembershipModel.updateMany(filter, {
    // Together, always: a row with `isDeleted` and no `revokedAt` reads as "removed at some unknown
    // time", and the whole reason this is a soft delete is to be able to say when.
    $set: { isDeleted: true, revokedAt: now },
  });

  for (const id of new Set(affected)) projectMembershipChanged({ orgId: orgKey, userId: id });
  return res.modifiedCount ?? 0;
}

/**
 * Remove a room's grants outright, for a room whose row is being HARD deleted (decision 32).
 *
 * The one place a grant is removed rather than cleared, and it is not an exception to
 * {@link revokeProjectGrants} so much as a different act. `DELETE /api/projects/:id` is a
 * `deleteOne`, not a soft delete, so the room is gone for good: a grant left behind with `revokedAt`
 * set would answer "who has ever been in this room" about a room nothing can name, and would sit in
 * the collection for ever because nothing ever queries a project id that no longer exists.
 *
 * Called AFTER the project row is deleted, deliberately. A crash between the two leaves grants for a
 * room that is gone, which is inert; the other order destroys the member list that says who to ask
 * while the room is still there, which is the unrecoverable half of the same bug.
 */
export async function deleteProjectGrants(params: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
}): Promise<number> {
  const orgKey = String(params.orgId);
  const projectKey = String(params.projectId);
  if (!Types.ObjectId.isValid(orgKey) || !Types.ObjectId.isValid(projectKey)) return 0;
  const projectId = new Types.ObjectId(projectKey);
  // Read the affected people first: after the delete there is no row left to say whose cached grant
  // set just changed.
  const rows = (await ProjectMembershipModel.find({ projectId })
    .select({ userId: 1 })
    .lean()) as Array<{ userId?: Types.ObjectId }>;
  const res = await ProjectMembershipModel.deleteMany({ projectId });
  for (const r of rows) if (r.userId) projectMembershipChanged({ orgId: orgKey, userId: r.userId });
  return res.deletedCount ?? 0;
}
