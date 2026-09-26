/**
 * Which channels an event goes to (docs/prds/lnkdrp-slack.md, decision 2).
 *
 * Pure, so the rule is testable without a database: the document's projects that are mapped to
 * a channel post there (a document in two mapped rooms posts to both); anything unmapped posts
 * to the default. A revoked connection never receives anything, and a connection whose switch
 * for this kind is off is left out. With a default only, every event goes to the default.
 *
 * The mapping is settled before the switches are read. A mapped room belongs to its channel
 * whatever that channel's switches say, so turning a switch off makes the room quiet instead of
 * moving it to the catch-all; see `routeSlackConnections`.
 */
import type { SlackEventKey } from "./connections";

export type RoutableConnection = {
  id: string;
  isDefault: boolean;
  status: "active" | "revoked";
  projectIds: readonly string[];
  events: Record<SlackEventKey, boolean>;
};

/**
 * Ordered, de-duplicated list of the connections that should receive this event.
 *
 * `allowDefault: false` is the contained-document rule (docs/prds/lnkdrp-project-home.md,
 * decision 6): the room's channel when mapped, otherwise nowhere. The catch-all exists so nothing
 * is lost; for a document that lives only inside its room, "lost" is the point.
 *
 * Mapping first, switches second. The switch used to be read in the same pass as `status`, which
 * dropped a mapped channel before the mapping step: `mapped` came back empty, the default took the
 * event, and turning the new-documents switch off on a data room's channel moved that room's
 * documents into the catch-all the whole Slack workspace reads. Off has to mean quiet. A mapped
 * room belongs to its channel, so the mapping is settled over every active connection and the
 * switch then decides whether that channel hears this kind, never whether another channel does.
 *
 * A channel that is removed altogether is a different thing and still falls back: nothing is
 * mapped to the room any more, so the default is where it was always going to land.
 */
export function routeSlackConnections<T extends RoutableConnection>(
  connections: readonly T[],
  kind: SlackEventKey,
  projectIds: readonly string[],
  opts: { allowDefault?: boolean } = {},
): T[] {
  const active = connections.filter((c) => c.status === "active");
  if (!active.length) return [];
  const wanted = new Set(projectIds.filter(Boolean));
  const mapped = wanted.size ? active.filter((c) => c.projectIds.some((p) => wanted.has(p))) : [];
  if (mapped.length) return mapped.filter((c) => c.events[kind]);
  if (opts.allowDefault === false) return [];
  const def = active.find((c) => c.isDefault && c.events[kind]);
  return def ? [def] : [];
}

/** Slack allows about one post per second per webhook; past this many in a minute the rest wait. */
export const SLACK_BURST_PER_MINUTE = 30;
export const SLACK_BURST_WINDOW_MS = 60_000;

/**
 * How many of `candidates` may post now given `sentInWindow` already went out this minute.
 * The rest are held for the next window (and the caller says "…and N more" once).
 */
export function burstAllowance(sentInWindow: number, candidates: number, cap: number = SLACK_BURST_PER_MINUTE): { allowed: number; held: number } {
  const room = Math.max(0, cap - Math.max(0, sentInWindow));
  const allowed = Math.min(room, Math.max(0, candidates));
  return { allowed, held: Math.max(0, candidates) - allowed };
}
