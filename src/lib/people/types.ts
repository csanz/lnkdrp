/**
 * The response contract of `GET /api/activity/actor` (the person and agent pages).
 *
 * Client-safe on purpose: the page component and the route both import these, so the shape the
 * server builds and the shape the browser renders cannot drift, and nothing in this file may reach
 * for Mongoose or the models (it would follow the import into the bundle).
 *
 * The profile is a header, not a report. It answers "who is this, when were they active, what did
 * they touch" in one bounded payload; the feed underneath it is the real record and is paged by
 * `GET /api/activity?actor=`, which is why nothing here is cursored.
 */
import type { ActivitySummaryCountKey } from "@/lib/activity/summary";

/** How many documents, projects or agents a profile will name before it stops being a list. */
export const ACTOR_PROFILE_LIST_LIMIT = 50;

/**
 * An agent connected by the person whose page this is.
 *
 * People and their agents are separate contributors with separate pages (an agent's work is the
 * agent's), so the person page carries this list as the link between them rather than folding the
 * agent's actions into the person's totals.
 */
export type ActorProfileAgent = {
  /** `agent:<client>@<thisPersonsUserId>`; see `src/lib/people/contributorKey.ts`. */
  key: string;
  client: string;
  /** `agentLabel(client)`, the same name the activity donut and the contributor cards print. */
  label: string;
  actions: number;
  lastAt: string | null;
  href: string;
};

/**
 * The member who connected an agent.
 *
 * Every field is nullable independently: a credential whose creator was never recorded has no
 * `userId` and therefore no `href`, while a member who has since deleted their account still has an
 * id worth linking (their page keeps their work) but no name or email left to print.
 */
export type ActorProfileOwner = {
  userId: string | null;
  name: string | null;
  email: string | null;
  href: string | null;
};

/** A document this contributor worked on. `href` is null once the document is deleted. */
export type ActorProfileDoc = {
  id: string;
  title: string | null;
  deleted: boolean;
  actions: number;
  lastAt: string;
  href: string | null;
};

/** A project this contributor worked on or in. */
export type ActorProfileProject = {
  id: string;
  name: string | null;
  actions: number;
  lastAt: string;
  href: string;
};

/**
 * One contributor's page, people and agents alike.
 *
 * The two kinds share a shape rather than having a type each because the page is one component: a
 * person has `email` and `agents`, an agent has `client` and `owner`, and everything else (the
 * dates, the counts, the buckets, the two lists) means exactly the same thing for both.
 */
export type ActorProfile = {
  /** The serialised `ContributorKey` this profile answers for. */
  key: string;
  kind: "person" | "agent";
  /** A person's display name (name, else the email's local part), or `agentLabel(client)`. */
  name: string;
  /** People only. */
  email: string | null;
  /** Agents only: the MCP client id. */
  client: string | null;
  /** Agents only: the member who connected it. */
  owner: ActorProfileOwner | null;
  firstAt: string | null;
  lastAt: string | null;
  /** Every row matching this actor that the feed would show, of any type. */
  totalActions: number;
  /** The subset that is work (`ACTIVITY_WORK_TYPES`): what the tiles and `byType` are about. */
  workActions: number;
  /** The header strip's counts, by the same `bucketForType` the `/activity` header uses. */
  buckets: Record<ActivitySummaryCountKey, number>;
  /** Work types only, most first, so the page can say what kind of work this mostly was. */
  byType: Array<{ type: string; count: number }>;
  docs: ActorProfileDoc[];
  projects: ActorProfileProject[];
  /** People only: the agents this person connected. Always `[]` on an agent's own profile. */
  agents: ActorProfileAgent[];
  href: string;
};
