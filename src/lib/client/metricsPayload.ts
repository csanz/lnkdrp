/**
 * Merging a metrics refresh into what the page already shows.
 *
 * The metrics page refetches its lightweight payload (`?lite=1`) on every realtime frame and on a
 * fallback timer. That payload never carries viewer rows: `viewers` and `anonymousViewers` come
 * back empty and the page asks for them in a second request once the first lands. Replacing the
 * whole payload on a silent refresh therefore blanked the viewer list every few seconds while
 * someone was reading, until the follow-up request put it back (code review 2026-09-23, M23).
 *
 * The rule: a silent refresh keeps the rows it has until a response that actually asked for them
 * arrives. A first load, or a deliberate change of range or link, takes the new payload as is.
 */

/** The slice of a metrics payload this merge cares about. */
export type ViewerRowsPayload = {
  viewers?: unknown[];
  anonymousViewers?: unknown[];
  /** Project-link rows; the viewers response is the one that carries names on them. */
  projectLinkTraffic?: unknown;
};

/**
 * `next` for a fresh load; on a silent refresh, `next` with the previous viewer rows kept where
 * `next` has none. `projectLinkTraffic` is kept too when `next` omits it, and taken from `next`
 * when present (its counts are fresh; names arrive with the viewers response that follows).
 */
export function mergeSilentRefresh<T extends ViewerRowsPayload>(prev: T | null, next: T, silent: boolean): T {
  if (!silent || !prev) return next;
  const out: T = { ...next };
  if (!(Array.isArray(next.viewers) && next.viewers.length > 0) && Array.isArray(prev.viewers) && prev.viewers.length > 0) {
    out.viewers = prev.viewers;
  }
  if (
    !(Array.isArray(next.anonymousViewers) && next.anonymousViewers.length > 0) &&
    Array.isArray(prev.anonymousViewers) &&
    prev.anonymousViewers.length > 0
  ) {
    out.anonymousViewers = prev.anonymousViewers;
  }
  if (next.projectLinkTraffic === undefined && prev.projectLinkTraffic !== undefined) {
    out.projectLinkTraffic = prev.projectLinkTraffic;
  }
  return out;
}
