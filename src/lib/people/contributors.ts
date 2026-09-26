/**
 * Who made this — the person who created a document or project, and everyone who worked on it since.
 *
 * Both halves already existed and neither was ever shown. `Doc.userId` and `Project.userId` record
 * the creator; `ActivityEvent` records every action with the actor who took it. So a workspace
 * where three people share a deck could tell you nothing about which of them wrote it, replaced it,
 * or minted the link a recipient is reading.
 *
 * Contributors come from the activity log rather than from the model fields, because the fields
 * only answer "who owns the row". `ShareLink.createdByUserId` knows who made a link but not who
 * later changed its password; `Upload.userId` knows who uploaded one version. The log knows all of
 * it, in one indexed query per document (`{ docId, createdDate }`).
 *
 * **Reading is not contributing.** Only `ACTIVITY_WORK_TYPES` count — the same set the activity
 * donut uses — so a recipient opening a document forty times never appears here.
 *
 * **Agents are listed, and marked.** An MCP client that files documents is genuinely a contributor
 * and hiding it would misreport who did the work; rendering it as a colleague would be worse. It
 * carries the same `agent` marking the activity donut uses, so the two screens agree.
 */
import { Types } from "mongoose";

import { agentLabel } from "@/lib/activity/log";
import { ACTIVITY_WORK_TYPES } from "@/lib/activity/summary";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { UserModel } from "@/lib/models/User";
import { agentKey, contributorHref, personKey } from "@/lib/people/contributorKey";

export type Contributor = {
  /** `user:<id>` or `agent:<client>@<ownerUserId|unknown>` (see `src/lib/people/contributorKey.ts`). */
  key: string;
  kind: "person" | "agent";
  name: string;
  /** Null for agents, and for a person whose account is gone. */
  email: string | null;
  /** How many pieces of work are attributed to them — enough to order by, not a statistic. */
  actions: number;
  lastAt: string;
  /** The page listing everything this contributor did; null when the key cannot be addressed. */
  href: string | null;
  /** Agents only: the member who connected the client. Null for people, and for an unknown owner. */
  ownerUserId: string | null;
};

export type Authorship = {
  /** Who created it. Null when the creator's account has been deleted. */
  author: Contributor | null;
  /** Everyone else who did work on it, most recent first. Never includes the author. */
  contributors: Contributor[];
};

/**
 * Actor kinds that can contribute.
 *
 * `viewer` and `temp` are readers and anonymous sessions — the people the analytics are *about*,
 * not the people who made the thing. `secret` is the request-inbox upload path, where the actor is
 * synthesised from the repo owner rather than the person who actually dropped the file off;
 * counting it would credit the owner with a stranger's upload, which is the same misattribution
 * that had to be fixed in the new-document email.
 */
const CONTRIBUTING_ACTOR_KINDS = new Set(["user", "api_key"]);

/** Enough to show a team; past this the list stops being a list and becomes a report. */
const MAX_CONTRIBUTORS = 12;

/** A bound on the scan, not on the truth: the newest work decides who is shown. */
const SCAN_LIMIT = 500;

type Scope = { docId?: string | null; projectId?: string | null };

function displayName(name: unknown, email: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return n;
  const e = typeof email === "string" ? email.trim() : "";
  // The address beats "Someone", and its local part beats the whole address in a dense list.
  return e ? e.split("@")[0]! : "Someone";
}

export async function loadAuthorship(params: {
  orgId: Types.ObjectId | string;
  /** The creator, from `Doc.userId` or `Project.userId`. */
  creatorUserId?: Types.ObjectId | string | null;
  scope: Scope;
}): Promise<Authorship> {
  const orgId = Types.ObjectId.isValid(String(params.orgId)) ? new Types.ObjectId(String(params.orgId)) : null;
  if (!orgId) return { author: null, contributors: [] };

  const match: Record<string, unknown> = { orgId, type: { $in: ACTIVITY_WORK_TYPES } };
  if (params.scope.docId && Types.ObjectId.isValid(params.scope.docId)) {
    match.docId = new Types.ObjectId(params.scope.docId);
  } else if (params.scope.projectId && Types.ObjectId.isValid(params.scope.projectId)) {
    match.projectId = new Types.ObjectId(params.scope.projectId);
  } else {
    // No scope is not "the whole workspace"; it is a caller that resolved nothing.
    return { author: null, contributors: [] };
  }

  const rows = (await ActivityEventModel.find(match)
    .select({ userId: 1, actorKind: 1, "agent.client": 1, createdDate: 1 })
    .sort({ createdDate: -1 })
    .limit(SCAN_LIMIT)
    .lean()) as Array<{
    userId?: unknown;
    actorKind?: unknown;
    agent?: { client?: unknown } | null;
    createdDate?: unknown;
  }>;

  const byKey = new Map<
    string,
    { kind: "person" | "agent"; userId: string; client: string; actions: number; lastAt: Date }
  >();

  for (const r of rows) {
    const kind = typeof r?.actorKind === "string" ? r.actorKind : "";
    if (!CONTRIBUTING_ACTOR_KINDS.has(kind)) continue;
    const at = r?.createdDate instanceof Date ? r.createdDate : null;
    if (!at) continue;

    const client = typeof r?.agent?.client === "string" ? r.agent.client.trim().toLowerCase() : "";
    const userId = r?.userId ? String(r.userId) : "";
    /**
     * Credit goes to the client, under the member who connected it.
     *
     * An agent is only meaningful as "this client, connected by this person": two members who each
     * connect Claude Code are two contributors, and crediting both to `agent:claude-code` would
     * print one member's filing under the other's name. The owner is the credential's creator
     * (`src/lib/gating/apiKeyActor.ts` puts it on the row as `userId`), so the same key reaches the
     * agent's page; a credential with no recorded creator groups under `@unknown`.
     */
    const key = client ? agentKey(client, userId || null) : userId ? personKey(userId) : "";
    if (!key) continue;

    const prev = byKey.get(key);
    if (prev) {
      prev.actions += 1;
      if (at > prev.lastAt) prev.lastAt = at;
    } else {
      byKey.set(key, { kind: client ? "agent" : "person", userId, client, actions: 1, lastAt: at });
    }
  }

  const creatorId = params.creatorUserId ? String(params.creatorUserId) : "";
  const personIds = Array.from(
    new Set(
      [
        ...Array.from(byKey.values())
          .filter((v) => v.kind === "person")
          .map((v) => v.userId),
        creatorId,
      ].filter(Boolean),
    ),
  );

  const people = new Map<string, { name: string; email: string | null }>();
  if (personIds.length) {
    const users = (await UserModel.find({ _id: { $in: personIds.map((id) => new Types.ObjectId(id)) } })
      .select({ _id: 1, name: 1, email: 1 })
      .lean()) as Array<{ _id?: unknown; name?: unknown; email?: unknown }>;
    for (const u of users) {
      const id = u?._id ? String(u._id) : "";
      if (!id) continue;
      people.set(id, {
        name: displayName(u?.name, u?.email),
        email: typeof u?.email === "string" ? u.email : null,
      });
    }
  }

  const creatorKey = creatorId ? personKey(creatorId) : "";
  const creatorWork = creatorKey ? byKey.get(creatorKey) : undefined;
  const author: Contributor | null =
    creatorId && people.has(creatorId)
      ? {
          key: creatorKey,
          kind: "person",
          name: people.get(creatorId)!.name,
          email: people.get(creatorId)!.email,
          actions: creatorWork?.actions ?? 0,
          lastAt: (creatorWork?.lastAt ?? new Date(0)).toISOString(),
          href: contributorHref(creatorKey),
          ownerUserId: null,
        }
      : null;

  const contributors = Array.from(byKey.entries())
    // The author is shown in their own right; repeating them below reads as two people.
    .filter(([key]) => key !== creatorKey)
    .map(([key, v]): Contributor => ({
      key,
      kind: v.kind,
      name:
        v.kind === "agent"
          ? (agentLabel({ client: v.client, version: null }) ?? v.client)
          : (people.get(v.userId)?.name ?? "Someone"),
      email: v.kind === "agent" ? null : (people.get(v.userId)?.email ?? null),
      actions: v.actions,
      lastAt: v.lastAt.toISOString(),
      href: contributorHref(key),
      ownerUserId: v.kind === "agent" ? (v.userId || null) : null,
    }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.actions - a.actions))
    .slice(0, MAX_CONTRIBUTORS);

  return { author, contributors };
}
