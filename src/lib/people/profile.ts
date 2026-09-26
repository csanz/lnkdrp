/**
 * Everything a contributor's page shows above its feed, in four bounded aggregates.
 *
 * The page could have been built from the feed alone by paging it to the end and counting in the
 * browser, which is exactly what it must not do: a member with ten thousand rows would then pay for
 * ten thousand rows to be told their first action was in March. The counts, the date range and the
 * two "what did they touch" lists are grouped in Mongo over the same match the feed uses, so the
 * header is one round trip whatever the volume and always agrees with the feed below it.
 *
 * The match is `buildActorFilter` plus the feed's hidden-row exclusion, and nothing else. In
 * particular the workspace feed's "documents kept inside a room" exclusion is deliberately absent:
 * that rule exists to keep a room's traffic out of the workspace-wide feed, and a person's own page
 * is not a workspace feed. Leaving it in would have printed "142 actions" in the header over a list
 * that showed sixty of them.
 *
 * Returning `null` for a contributor with no rows is what makes the route's 404 honest: it is the
 * only thing stopping `/people/<any 24 hex>` from rendering an empty page for a member of some
 * other workspace, so the emptiness check is a tenancy check and not a cosmetic one.
 */
import { Types } from "mongoose";

import { agentLabel } from "@/lib/activity/log";
import { feedHiddenClauses } from "@/lib/activity/feedVisibility";
import { ACTIVITY_WORK_TYPES, bucketForType, emptyCounts } from "@/lib/activity/summary";
import { resolveOwners } from "@/lib/agents/owners";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { DocModel } from "@/lib/models/Doc";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { projectNamesFor } from "@/lib/projects/names";
import { UserModel } from "@/lib/models/User";

import { buildActorFilter } from "./actorFilter";
import { agentKey, contributorHref, formatContributorKey, isClientId, type ContributorKey } from "./contributorKey";
import {
  ACTOR_PROFILE_LIST_LIMIT,
  type ActorProfile,
  type ActorProfileAgent,
  type ActorProfileDoc,
  type ActorProfileOwner,
  type ActorProfileProject,
} from "./types";

/** One `$group by type` row. */
type TypeRow = { _id?: unknown; n?: unknown; first?: unknown; last?: unknown };

/** One `$group by docId|projectId` row. */
type TargetRow = { _id?: unknown; n?: unknown; last?: unknown };

/** One `$group by agent.client` row on a person's own rows. */
type AgentRow = { _id?: unknown; n?: unknown; last?: unknown };

/** A work-type set that can be asked `has`, instead of a linear scan per row. */
const WORK_TYPES = new Set<string>(ACTIVITY_WORK_TYPES);

/** A count as it arrives from `$sum`, floored at zero so a bad row cannot make a negative total. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/** A `$min`/`$max` date as an ISO string, or null. */
function iso(v: unknown): string | null {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null;
}

/**
 * What to call a member.
 *
 * The local part beats the whole address in a page header, and "A member" beats a blank line for an
 * account that has been deleted since its work was recorded: the work is still theirs and the page
 * still has to name the row it is about.
 */
function displayName(name: unknown, email: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return n;
  const e = typeof email === "string" ? email.trim() : "";
  return e ? (e.split("@")[0] ?? "A member") : "A member";
}

/**
 * The member who connected an agent, for the "Connected by" line on its page.
 *
 * `unknown` is not an error and must not read like one: it is a credential whose creator was never
 * recorded, so every field comes back null and the page prints an unlinked phrase. A member who has
 * since deleted their account keeps their `href` (their page still holds their work) and loses
 * their name, which is the same treatment they get everywhere else in the product.
 */
export async function resolveAgentOwner(ownerUserId: string | null): Promise<ActorProfileOwner> {
  if (!ownerUserId) return { userId: null, name: null, email: null, href: null };
  const owners = await resolveOwners([ownerUserId]);
  const owner = owners.get(ownerUserId) ?? null;
  return {
    userId: ownerUserId,
    name: owner?.name?.trim() ? owner.name.trim() : null,
    email: owner?.email?.trim() ? owner.email.trim() : null,
    href: contributorHref({ kind: "person", userId: ownerUserId }),
  };
}

/** Group this actor's rows by a target id, newest first, bounded. */
async function loadTargets(
  match: Record<string, unknown>,
  field: "docId" | "projectId",
): Promise<TargetRow[]> {
  return (await ActivityEventModel.aggregate([
    { $match: { ...match, [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 }, last: { $max: "$createdDate" } } },
    { $sort: { last: -1 } },
    { $limit: ACTOR_PROFILE_LIST_LIMIT },
  ])) as TargetRow[];
}

/**
 * The documents behind the grouped rows, titled and marked deleted.
 *
 * The locked-room exclusion lands here and the existing "a purged document keeps its line" rule does the
 * rest (docs/prds/lnkdrp-locked-projects.md, decision 11): a document in a room this reader is outside
 * resolves to nothing, so its line loses its title and its link and reads exactly like a purged one.
 * That is the right shape — those two must not be distinguishable — and it keeps the contributor's
 * action count honest against the feed below.
 *
 * No `orgId` is added, deliberately: documents that predate workspaces carry none and this page renders
 * them for their owner in their own personal workspace.
 */
async function decorateDocs(
  rows: TargetRow[],
  viewer: { orgId: Types.ObjectId; viewerUserId: string | Types.ObjectId },
): Promise<ActorProfileDoc[]> {
  const ids = rows.map((r) => (r?._id ? String(r._id) : "")).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return [];
  const docs = (await DocModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    ...(await lockedHomeExclusionFor(viewer.orgId, viewer.viewerUserId)),
  })
    .select({ _id: 1, title: 1, isDeleted: 1 })
    .lean()) as Array<{ _id?: unknown; title?: unknown; isDeleted?: unknown }>;
  const byId = new Map(docs.map((d) => [String(d?._id ?? ""), d]));

  const out: ActorProfileDoc[] = [];
  for (const row of rows) {
    const id = row?._id ? String(row._id) : "";
    const last = iso(row?.last);
    if (!id || !last) continue;
    const doc = byId.get(id);
    // A row whose document has been purged outright is still a thing this contributor did, so it
    // keeps its line; it simply has no title and nowhere to go.
    const deleted = !doc || Boolean(doc.isDeleted);
    const title = typeof doc?.title === "string" && doc.title.trim() ? doc.title.trim() : null;
    out.push({
      id,
      title,
      deleted,
      actions: count(row?.n),
      lastAt: last,
      href: deleted ? null : `/doc/${encodeURIComponent(id)}`,
    });
  }
  return out;
}

/**
 * The projects behind the grouped rows, named as the reader may see them.
 *
 * Through `projectNamesFor` (docs/prds/lnkdrp-locked-projects.md, decision 14), which is also where the
 * missing `orgId` comes from. A room the reader holds no grant for is dropped from the list rather than
 * rendered nameless: this is a "what did this person work on" list, so a row with no name and a live
 * `/project/<id>` link is both an admission that the room exists and a link to a 404.
 *
 * The consequence is stated because it is a real one: a member's contribution counts in the header are
 * computed over their whole feed, so they can exceed what this list shows. That is the same divergence
 * the file header already documents for contained documents, and it is the honest direction.
 */
async function decorateProjects(
  rows: TargetRow[],
  viewer: { orgId: Types.ObjectId; viewerUserId: string | Types.ObjectId },
): Promise<ActorProfileProject[]> {
  const ids = rows.map((r) => (r?._id ? String(r._id) : "")).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return [];
  const byId = await projectNamesFor({ orgId: viewer.orgId, ids, viewerUserId: viewer.viewerUserId });

  const out: ActorProfileProject[] = [];
  for (const row of rows) {
    const id = row?._id ? String(row._id) : "";
    const last = iso(row?.last);
    if (!id || !last) continue;
    const name = byId.get(id) ?? null;
    if (!name) continue;
    out.push({ id, name, actions: count(row?.n), lastAt: last, href: `/project/${encodeURIComponent(id)}` });
  }
  return out;
}

/**
 * The agents this member has connected, as links to their pages.
 *
 * Its own aggregate over the member's rows *including* their agents' rows, which is the one place
 * this file looks outside `buildActorFilter`: the person's filter deliberately excludes agent rows,
 * and this list is precisely the question "what did that exclusion leave out".
 */
async function loadPersonAgents(orgId: Types.ObjectId, userId: string): Promise<ActorProfileAgent[]> {
  const rows = (await ActivityEventModel.aggregate([
    { $match: { orgId, userId: new Types.ObjectId(userId), "agent.client": { $type: "string" } } },
    { $group: { _id: "$agent.client", n: { $sum: 1 }, last: { $max: "$createdDate" } } },
    { $sort: { n: -1 } },
    { $limit: ACTOR_PROFILE_LIST_LIMIT },
  ])) as AgentRow[];

  const out: ActorProfileAgent[] = [];
  for (const row of rows) {
    const client = typeof row?._id === "string" ? row._id.trim().toLowerCase() : "";
    // A client id that would not round-trip through the key has no page to link to; skip it rather
    // than emit an href that cannot parse back.
    if (!isClientId(client)) continue;
    out.push({
      key: agentKey(client, userId),
      client,
      label: agentLabel({ client, version: null }) ?? client,
      actions: count(row?.n),
      lastAt: iso(row?.last),
      href: contributorHref({ kind: "agent", client, ownerUserId: userId }),
    });
  }
  return out;
}

/**
 * One contributor's profile in this workspace, or null when they have nothing here.
 *
 * `orgId` is not optional and is not derived from the key: the key names a contributor, the org
 * names the workspace asking, and the caller has already proved the caller belongs to it. Without
 * the org in the match, `/people/<id>` would answer for any member of any workspace.
 */
export async function loadActorProfile(params: {
  orgId: Types.ObjectId;
  key: ContributorKey;
  /** Who is reading the page, so the rooms it names are rooms they may see (decision 14). */
  viewerUserId: string | Types.ObjectId;
}): Promise<ActorProfile | null> {
  const { orgId, key } = params;
  const match: Record<string, unknown> = {
    orgId,
    ...buildActorFilter(key),
    $nor: feedHiddenClauses(),
  };

  const typeRows = (await ActivityEventModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$type",
        n: { $sum: 1 },
        first: { $min: "$createdDate" },
        last: { $max: "$createdDate" },
      },
    },
  ])) as TypeRow[];

  // No rows is the tenancy answer as well as the emptiness answer; see the file comment.
  if (!typeRows.length) return null;

  const buckets = emptyCounts();
  const byType: Array<{ type: string; count: number }> = [];
  let totalActions = 0;
  let workActions = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;

  for (const row of typeRows) {
    const type = typeof row?._id === "string" ? row._id : "";
    const n = count(row?.n);
    if (!type || !n) continue;
    totalActions += n;
    const first = row?.first instanceof Date ? row.first.getTime() : null;
    const last = row?.last instanceof Date ? row.last.getTime() : null;
    if (first !== null && !Number.isNaN(first)) firstMs = Math.min(firstMs, first);
    if (last !== null && !Number.isNaN(last)) lastMs = Math.max(lastMs, last);
    if (!WORK_TYPES.has(type)) continue;
    workActions += n;
    byType.push({ type, count: n });
    const bucket = bucketForType(type);
    if (bucket) buckets[bucket] += n;
  }

  byType.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const [docRows, projectRows] = await Promise.all([loadTargets(match, "docId"), loadTargets(match, "projectId")]);
  const viewer = { orgId, viewerUserId: params.viewerUserId };
  const [docs, projects] = await Promise.all([decorateDocs(docRows, viewer), decorateProjects(projectRows, viewer)]);

  const serialised = formatContributorKey(key);
  const href = contributorHref(key);
  const shared = {
    key: serialised,
    firstAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    lastAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    totalActions,
    workActions,
    buckets,
    byType,
    docs,
    projects,
    href,
  };

  if (key.kind === "agent") {
    const owner = await resolveAgentOwner(key.ownerUserId);
    return {
      ...shared,
      kind: "agent",
      name: agentLabel({ client: key.client, version: null }) ?? key.client,
      email: null,
      client: key.client,
      owner,
      agents: [],
    };
  }

  const user = (await UserModel.findById(new Types.ObjectId(key.userId))
    .select({ _id: 1, name: 1, email: 1 })
    .lean()) as { name?: unknown; email?: unknown } | null;
  const agents = await loadPersonAgents(orgId, key.userId);

  return {
    ...shared,
    kind: "person",
    name: displayName(user?.name, user?.email),
    email: typeof user?.email === "string" && user.email.trim() ? user.email.trim() : null,
    client: null,
    owner: null,
    agents,
  };
}
