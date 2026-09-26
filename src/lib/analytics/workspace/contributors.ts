/**
 * Who did the work in the window: people in the app, and agents through the MCP.
 *
 * The rest of the workspace metrics page answers "what did readers do". This answers "what did we
 * do", which on this product is a different and increasingly agent-shaped question: a workspace
 * where an agent files every incoming document should be able to see that at a glance, and a
 * workspace where it does not should see that too.
 *
 * Work is the Activity page's own vocabulary (`ACTIVITY_WORK_TYPES`), so "an action" means exactly
 * the same thing on both pages, and a type added to a filter group there joins this list with no
 * second definition to keep in step. Views and downloads are not work — they are what the rest of
 * the page already counts, and folding them in would double-count a reader as a contributor.
 *
 * An agent is credited to its client, never to the person whose key it used: "Claude Code created
 * nine links" and "Christian created nine links" are different facts, and the first is the one this
 * product exists to show. The client is still qualified by the member who connected it, because an
 * agent is only meaningful as "this client, connected by this person" — two members who each
 * connect Claude Code are two contributors, and the row names the owner on its second line.
 */
import { Types } from "mongoose";

import { ACTIVITY_WORK_TYPES, bucketForType } from "@/lib/activity/summary";
import { agentLabel } from "@/lib/activity/log";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { UserModel } from "@/lib/models/User";
import { agentKey, contributorHref, personKey } from "@/lib/people/contributorKey";
import { WORKSPACE_CONTRIBUTORS_LIMIT, type WorkspaceContributor } from "./types";

/** One `{ actor, type }` bucket as Mongo returns it. */
type ContributorRow = {
  _id?: { userId?: Types.ObjectId | null; client?: string | null; type?: string | null } | null;
  n?: number;
  lastAt?: Date | null;
};

/** Accumulator per contributor, before names are resolved. */
type Draft = {
  key: string;
  kind: "person" | "agent";
  /** The person for a person row; the member who connected the client for an agent row. */
  userId: string | null;
  client: string | null;
  actions: number;
  docsAdded: number;
  linksCreated: number;
  docsReplaced: number;
  lastAt: number;
};

/** Most actions first, then most recent, then key — so equal rows never reorder between calls. */
function byActionsThenRecency(a: Draft, b: Draft): number {
  return b.actions - a.actions || b.lastAt - a.lastAt || a.key.localeCompare(b.key);
}

/**
 * Contributors in the window, ranked.
 *
 * Two bounded reads: one aggregate over the workspace's activity rows, then one name lookup for
 * the handful of people who survive the ranking — never a user lookup per row.
 */
export async function loadContributors(params: {
  orgId: Types.ObjectId;
  start: Date;
  endExclusive: Date;
  limit?: number;
}): Promise<WorkspaceContributor[]> {
  const limit = Math.max(1, params.limit ?? WORKSPACE_CONTRIBUTORS_LIMIT);

  const rows = (await ActivityEventModel.aggregate([
    {
      $match: {
        orgId: params.orgId,
        type: { $in: [...ACTIVITY_WORK_TYPES] },
        createdDate: { $gte: params.start, $lt: params.endExclusive },
      },
    },
    {
      $group: {
        _id: { userId: "$userId", client: "$agent.client", type: "$type" },
        n: { $sum: 1 },
        lastAt: { $max: "$createdDate" },
      },
    },
  ])) as ContributorRow[];

  const drafts = new Map<string, Draft>();
  for (const row of rows) {
    const client = typeof row?._id?.client === "string" ? row._id.client.trim().toLowerCase() : "";
    const userId = row?._id?.userId ? String(row._id.userId) : "";
    // An agent row is credited to the client under the member who connected it, which is what makes
    // two members who each connect Claude Code two rows rather than one. A row with neither an agent
    // nor a user is a system action (a cron, a webhook) and belongs to nobody, so it is dropped
    // rather than attributed.
    const key = client ? agentKey(client, userId || null) : userId ? personKey(userId) : "";
    if (!key) continue;

    const count = typeof row.n === "number" && Number.isFinite(row.n) ? Math.max(0, Math.trunc(row.n)) : 0;
    if (!count) continue;
    const at = row.lastAt instanceof Date ? row.lastAt.getTime() : 0;

    const draft = drafts.get(key) ?? {
      key,
      kind: client ? ("agent" as const) : ("person" as const),
      // Kept on agent drafts too: it is the owner, and the row's second line names them.
      userId: userId || null,
      client: client || null,
      actions: 0,
      docsAdded: 0,
      linksCreated: 0,
      docsReplaced: 0,
      lastAt: 0,
    };
    draft.actions += count;
    draft.lastAt = Math.max(draft.lastAt, at);
    switch (bucketForType(String(row?._id?.type ?? ""))) {
      case "docsAdded":
        draft.docsAdded += count;
        break;
      case "linksCreated":
        draft.linksCreated += count;
        break;
      case "docsReplaced":
        draft.docsReplaced += count;
        break;
      default:
        // Counted in `actions`, with no tile of its own (archived, deleted, project created).
        break;
    }
    drafts.set(key, draft);
  }

  const ranked = [...drafts.values()].sort(byActionsThenRecency).slice(0, limit);
  if (!ranked.length) return [];

  // Agents' owners go into the same `$in` as the people: the list has to name them too, and a
  // second query for one extra id per agent row would be a query per agent.
  const userIds = Array.from(
    new Set(ranked.filter((d) => d.userId && Types.ObjectId.isValid(d.userId)).map((d) => String(d.userId))),
  ).map((id) => new Types.ObjectId(id));
  const users = userIds.length
    ? ((await UserModel.find({ _id: { $in: userIds } })
        .select({ _id: 1, name: 1, email: 1 })
        .lean()) as Array<{ _id: Types.ObjectId; name?: unknown; email?: unknown }>)
    : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));

  /** What is left of a member to print: their name, else their address, else a placeholder. */
  function displayName(id: string | null): string {
    const user = id ? userById.get(id) : null;
    const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : "";
    const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : "";
    // A deleted or purged teammate keeps their work on the page, named by what is left of them.
    return name || email || "Someone in this workspace";
  }

  return ranked.map((d): WorkspaceContributor => {
    if (d.kind === "agent") {
      return {
        key: d.key,
        kind: "agent",
        name: agentLabel({ client: d.client ?? "", version: null }) ?? d.client ?? "Agent",
        email: null,
        client: d.client,
        ownerUserId: d.userId,
        // Null rather than a placeholder when the credential has no recorded creator: the row says
        // "by an unknown member" in the UI, which is not the same sentence as a missing name.
        ownerName: d.userId ? displayName(d.userId) : null,
        actions: d.actions,
        docsAdded: d.docsAdded,
        linksCreated: d.linksCreated,
        docsReplaced: d.docsReplaced,
        lastActiveAt: d.lastAt ? new Date(d.lastAt).toISOString() : null,
        href: contributorHref({ kind: "agent", client: d.client ?? "", ownerUserId: d.userId }),
      };
    }
    const user = d.userId ? userById.get(d.userId) : null;
    const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : "";
    return {
      key: d.key,
      kind: "person",
      name: displayName(d.userId),
      email: email || null,
      client: null,
      ownerUserId: null,
      ownerName: null,
      actions: d.actions,
      docsAdded: d.docsAdded,
      linksCreated: d.linksCreated,
      docsReplaced: d.docsReplaced,
      lastActiveAt: d.lastAt ? new Date(d.lastAt).toISOString() : null,
      href: contributorHref({ kind: "person", userId: d.userId ?? "" }),
    };
  });
}
