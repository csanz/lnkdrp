/**
 * Caps on live MCP sessions, per credential and in total.
 *
 * Sessions live in a process-local Map and cost a connected `McpServer` plus a transport each.
 * Nothing bounded how many one key could open: a client looping `initialize` at the rate limit
 * (300 a minute) would hold about eighteen thousand live sessions by the time the idle sweep
 * (one hour) reached the first of them, on the single machine every connected agent shares
 * (code review 2026-09-23, M17).
 *
 * Two caps. **Per credential** (an API key or an OAuth grant, whichever `whoami` reported as the
 * `credentialId`): when a credential is at its cap, its oldest idle session is closed to make room,
 * because the usual cause is a client reconnecting without ever closing, and evicting its stalest
 * session is what it wanted anyway. **Global**: when the process is at its total cap the new
 * session is refused with a JSON-RPC error rather than evicting somebody else's, since that would
 * let one credential push every other agent off the server. Both are pure decisions here so they
 * can be tested without a transport.
 */

export type SessionCaps = {
  /** Live sessions one credential may hold at once. */
  perCredential: number;
  /** Live sessions the process may hold at once, across every credential. */
  total: number;
};

export const DEFAULT_SESSION_CAPS: SessionCaps = { perCredential: 20, total: 500 };

/** What the decision needs to know about a live session. */
export type SessionSummary = {
  id: string;
  credentialId: string;
  lastSeenAt: number;
};

export type SessionAdmission =
  | { admit: true; evict: string[] }
  | { admit: false; evict: []; reason: "total_cap" };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Caps from the environment: `LNKDRP_MCP_MAX_SESSIONS_PER_KEY` and `LNKDRP_MCP_MAX_SESSIONS`,
 * falling back to the defaults. A non-number or a zero is ignored, not honoured as "no cap".
 */
export function sessionCapsFromEnv(env: NodeJS.ProcessEnv = process.env): SessionCaps {
  return {
    perCredential: positiveInt(env.LNKDRP_MCP_MAX_SESSIONS_PER_KEY, DEFAULT_SESSION_CAPS.perCredential),
    total: positiveInt(env.LNKDRP_MCP_MAX_SESSIONS, DEFAULT_SESSION_CAPS.total),
  };
}

/**
 * Decide whether a new session for `credentialId` may open, and which existing sessions must close
 * first. Evictions are the credential's own sessions, oldest `lastSeenAt` first, as many as it takes
 * to get one under the per-credential cap. The total cap is checked after those evictions, since
 * closing one of the credential's own sessions also frees a global slot.
 */
export function admitSession(
  live: Iterable<SessionSummary>,
  credentialId: string,
  caps: SessionCaps = DEFAULT_SESSION_CAPS,
): SessionAdmission {
  const all = Array.from(live);
  const own = all.filter((s) => s.credentialId === credentialId).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  const evict: string[] = [];
  while (own.length - evict.length >= caps.perCredential && evict.length < own.length) {
    evict.push(own[evict.length].id);
  }
  if (all.length - evict.length >= caps.total) return { admit: false, evict: [], reason: "total_cap" };
  return { admit: true, evict };
}
