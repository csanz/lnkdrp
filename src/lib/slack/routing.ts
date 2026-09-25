/**
 * Which channels an event goes to (docs/prds/lnkdrp-slack.md, decision 2).
 *
 * Pure, so the rule is testable without a database: the document's projects that are mapped to
 * a channel post there (a document in two mapped rooms posts to both); anything unmapped posts
 * to the default. A revoked connection never receives anything, and a connection whose switch
 * for this kind is off is left out. With a default only, every event goes to the default.
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
 */
export function routeSlackConnections<T extends RoutableConnection>(
  connections: readonly T[],
  kind: SlackEventKey,
  projectIds: readonly string[],
  opts: { allowDefault?: boolean } = {},
): T[] {
  const live = connections.filter((c) => c.status === "active" && c.events[kind]);
  if (!live.length) return [];
  const wanted = new Set(projectIds.filter(Boolean));
  const mapped = wanted.size ? live.filter((c) => c.projectIds.some((p) => wanted.has(p))) : [];
  if (mapped.length) return mapped;
  if (opts.allowDefault === false) return [];
  const def = live.find((c) => c.isDefault);
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
