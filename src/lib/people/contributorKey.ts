/**
 * The one definition of "who did this" as an addressable identity.
 *
 * Four surfaces had their own idea of a contributor key: the document's ContributorsCard used a
 * bare user id or `agent:<client>`, the workspace metrics card used `user:<id>` or `agent:<client>`,
 * the activity donut used `agent:<client>` for a slice, and nothing at all could turn any of them
 * into a link. Once a contributor has a page, the key stops being a grouping token inside one
 * response and becomes a name the whole product has to spell the same way, so it lives here, alone,
 * in a file with no Mongoose import so the browser can parse and format keys too.
 *
 * **An agent key carries its owner.** An agent is only meaningful as "this client, connected by
 * this person": two members who each connect Claude Code are two contributors, not one, and
 * crediting both to `agent:claude-code` would print one person's filing under another's name. The
 * owner is the member who minted the credential (`ActivityEvent.userId` on rows that carry
 * `agent.client`), so the key is `agent:<client>@<ownerUserId>`. `@` is the separator because it
 * cannot occur in a client id and is safe in a URL path segment.
 *
 * Keys serialised before that decision (`agent:<client>`, no owner) still parse, as owner `unknown`.
 * Nothing emits them any more.
 */

/** The owner segment of an agent whose credential's creator is not known. */
export const UNKNOWN_OWNER = "unknown";

/**
 * A contributor, parsed.
 *
 * `ownerUserId: null` is the `unknown` owner: rows written by a credential whose `userId` was never
 * recorded. It is a real, linkable contributor (its work happened), it simply has no person page to
 * point at.
 */
export type ContributorKey =
  | { kind: "person"; userId: string }
  | { kind: "agent"; client: string; ownerUserId: string | null };

/** 24 lowercase hex characters: what `String(ObjectId)` produces, and all this module accepts. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

/** The client ids `normalizeClientId` (`src/lib/activity/log.ts`) can ever have stored. */
const CLIENT_ID_RE = /^[a-z0-9._-]{1,64}$/;

/**
 * Is this a user id in the form a key may carry?
 *
 * Deliberately stricter than `Types.ObjectId.isValid`, which accepts any 12-character string and
 * would let `agent:x@anystring12` through as a valid owner and then 404 at the database.
 */
export function isObjectIdHex(s: string): boolean {
  return OBJECT_ID_RE.test(s);
}

/** Is this an MCP client id as the activity log normalises them? */
export function isClientId(s: string): boolean {
  return CLIENT_ID_RE.test(s);
}

/**
 * Parse a serialised key, or null when it is not one.
 *
 * Every entry point (route param, query string, MCP argument) goes through this rather than a
 * regex of its own, so "what is a valid contributor" is answered once and an unparsable key fails
 * the same way everywhere instead of reaching Mongo as a filter on nothing.
 */
export function parseContributorKey(raw: string): ContributorKey | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;

  if (s.startsWith("user:")) {
    const userId = s.slice("user:".length);
    return isObjectIdHex(userId) ? { kind: "person", userId } : null;
  }

  if (s.startsWith("agent:")) {
    const rest = s.slice("agent:".length);
    const at = rest.indexOf("@");
    // Legacy `agent:<client>`: accepted, and read as the unknown owner rather than rejected, so an
    // old link or a stored key from before owners existed still resolves to something.
    const client = at >= 0 ? rest.slice(0, at) : rest;
    const owner = at >= 0 ? rest.slice(at + 1) : UNKNOWN_OWNER;
    if (!isClientId(client)) return null;
    if (owner === UNKNOWN_OWNER) return { kind: "agent", client, ownerUserId: null };
    return isObjectIdHex(owner) ? { kind: "agent", client, ownerUserId: owner } : null;
  }

  return null;
}

/**
 * Serialise a key.
 *
 * An agent always gets an explicit `@<owner|unknown>`, so a key that came back from this product
 * has exactly one spelling and two surfaces can compare keys as strings.
 */
export function formatContributorKey(k: ContributorKey): string {
  return k.kind === "person" ? `user:${k.userId}` : `agent:${k.client}@${k.ownerUserId ?? UNKNOWN_OWNER}`;
}

/** The key for a member, from an id you already trust (a row's `userId`). */
export function personKey(userId: string): string {
  return `user:${userId}`;
}

/** The key for a client connected by a member, with `unknown` standing in for a missing owner. */
export function agentKey(client: string, ownerUserId: string | null | undefined): string {
  return `agent:${client}@${ownerUserId ? String(ownerUserId) : UNKNOWN_OWNER}`;
}

/**
 * The page that lists everything this contributor did, or null when the key is not one.
 *
 * Returning null rather than throwing is what lets every caller render a plain name instead of a
 * link for a row it cannot address (a system action, a malformed key) without a branch of its own.
 */
export function contributorHref(k: ContributorKey): string;
export function contributorHref(k: string): string | null;
export function contributorHref(k: ContributorKey | string): string | null {
  const key = typeof k === "string" ? parseContributorKey(k) : k;
  if (!key) return null;
  if (key.kind === "person") return `/people/${encodeURIComponent(key.userId)}`;
  return `/agents/${encodeURIComponent(key.client)}/${encodeURIComponent(key.ownerUserId ?? UNKNOWN_OWNER)}`;
}

/**
 * The key a route's params name, or null when the params are not a contributor.
 *
 * The two page routes carry the key split across path segments rather than as one string, and this
 * is the join: a server page validates with it and calls `notFound()` on null, so a hand-typed URL
 * can never reach a query.
 */
export function keyFromRoute(
  params: { userId: string } | { client: string; ownerUserId: string },
): ContributorKey | null {
  if ("userId" in params) return parseContributorKey(personKey(String(params.userId ?? "").trim().toLowerCase()));
  const client = String(params.client ?? "").trim().toLowerCase();
  const owner = String(params.ownerUserId ?? "").trim().toLowerCase();
  return parseContributorKey(`agent:${client}@${owner}`);
}

/**
 * The key an activity row belongs to: the agent that acted, else the person, else nobody.
 *
 * The order matters and is the rule the whole feature rests on. A row with an `agent.client` is the
 * agent's action, not its owner's, so it is credited to `agent:<client>@<userId>`; the owner is one
 * click away on the agent's page. A row without one is the person's own work in the app. A row with
 * neither is a system action (a cron, a webhook) and belongs to no contributor, so it gets null
 * rather than being attributed to whoever happens to be nearby.
 */
export function keyFromActivityRow(row: {
  userId?: unknown;
  agent?: { client?: unknown } | null;
}): ContributorKey | null {
  const client = typeof row?.agent?.client === "string" ? row.agent.client.trim().toLowerCase() : "";
  const userId = row?.userId ? String(row.userId) : "";
  if (client) {
    if (!isClientId(client)) return null;
    return { kind: "agent", client, ownerUserId: isObjectIdHex(userId) ? userId : null };
  }
  return isObjectIdHex(userId) ? { kind: "person", userId } : null;
}
