/**
 * Turning aggregate rows into the page's shape: deltas, the zero-filled day series, the ranked
 * lists and the quiet-document selection. Pure — no database, no framework — so every rule here is
 * unit-tested (tests/lib/workspaceMetrics.test.ts) instead of being verified by eye on live data.
 */
import type {
  WorkspaceMetricDelta,
  WorkspacePerson,
  WorkspaceQuietDoc,
  WorkspaceSeriesPoint,
  WorkspaceTopDoc,
  WorkspaceTopLink,
} from "./types";

/** A non-negative integer, whatever Mongo or a caller handed over. */
export function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** An ISO string for a date-ish value, or `null` — the only date form that leaves this endpoint. */
export function toIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Percent change, or `null` when a percentage would be meaningless.
 *
 * `null` in two cases the UI must render differently from 0%: no previous period was served (Free),
 * and a previous period of zero — the seed corpus's 30-day window has an empty period before it, so
 * "+∞%" and a divide-by-zero `NaN` are both one real dataset away. The UI says "new" for those.
 */
export function changePct(value: number, previous: number | null): number | null {
  if (previous === null || !Number.isFinite(previous) || previous <= 0) return null;
  const pct = ((value - previous) / previous) * 100;
  return Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null;
}

/** A headline figure with its comparison. */
export function delta(value: number, previous: number | null): WorkspaceMetricDelta {
  const v = safeCount(value);
  const p = previous === null ? null : safeCount(previous);
  return { value: v, previous: p, changePct: changePct(v, p) };
}

/** One day's buckets, keyed by UTC day, as the aggregations produce them. */
export type DayBuckets = {
  views: Map<string, number>;
  opens: Map<string, number>;
  readingTimeMs: Map<string, number>;
  downloads: Map<string, number>;
};

/**
 * Every day in the range, zero-filled and in order.
 *
 * Gaps are filled here rather than in the chart because the area under each series has to equal its
 * headline figure: a missing day is a zero, not a straight line between its neighbours.
 */
export function buildSeries(dayKeys: string[], buckets: DayBuckets): WorkspaceSeriesPoint[] {
  return dayKeys.map((day) => ({
    day,
    views: safeCount(buckets.views.get(day)),
    opens: safeCount(buckets.opens.get(day)),
    readingTimeMs: safeCount(buckets.readingTimeMs.get(day)),
    downloads: safeCount(buckets.downloads.get(day)),
  }));
}

/** Reading time per viewer, rounded; `0` rather than a division by zero when nobody read it. */
export function avgReadingTimeMs(readingTimeMs: number, viewers: number): number {
  const ms = safeCount(readingTimeMs);
  const people = safeCount(viewers);
  return people > 0 ? Math.round(ms / people) : 0;
}

/** The document's own metrics page — where every document row on this page leads. */
export function docMetricsHref(docId: string): string {
  return `/doc/${docId}/metrics`;
}

/** The same page, filtered to one link: the form the metrics page itself uses for `?shareId=`. */
export function linkMetricsHref(docId: string, shareId: string): string {
  return `/doc/${docId}/metrics?shareId=${encodeURIComponent(shareId)}`;
}

/** Descending by `a`, then `b`, then most recent, then id — so equal rows never reorder between calls. */
function byViewsThenRecency<T extends { views: number; viewers?: number; lastOpenedAt: string | null }>(
  a: T,
  b: T,
  idOf: (row: T) => string,
): number {
  if (b.views !== a.views) return b.views - a.views;
  const av = a.viewers ?? 0;
  const bv = b.viewers ?? 0;
  if (bv !== av) return bv - av;
  const at = a.lastOpenedAt ? Date.parse(a.lastOpenedAt) : 0;
  const bt = b.lastOpenedAt ? Date.parse(b.lastOpenedAt) : 0;
  if (bt !== at) return bt - at;
  return idOf(a).localeCompare(idOf(b));
}

/** Top documents by views, bounded. */
export function rankTopDocs(rows: WorkspaceTopDoc[], limit: number): WorkspaceTopDoc[] {
  return [...rows].sort((a, b) => byViewsThenRecency(a, b, (r) => r.docId)).slice(0, Math.max(0, limit));
}

/** Top links by views, bounded. */
export function rankTopLinks(rows: WorkspaceTopLink[], limit: number): WorkspaceTopLink[] {
  return [...rows].sort((a, b) => byViewsThenRecency(a, b, (r) => r.shareId)).slice(0, Math.max(0, limit));
}

/**
 * Most engaged people: reading time first, because the question this list answers is "who is
 * actually reading", not "who clicked most".
 *
 * Ties break on documents rather than views: a person's row is built from their visits in the
 * window, which count sessions and documents but not views, and a tiebreak nobody can fill for
 * every row is a tiebreak that sorts on a hole.
 */
export function rankPeople(rows: WorkspacePerson[], limit: number): WorkspacePerson[] {
  return [...rows]
    .sort((a, b) => {
      if (b.readingTimeMs !== a.readingTimeMs) return b.readingTimeMs - a.readingTimeMs;
      if (b.docs !== a.docs) return b.docs - a.docs;
      const at = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0;
      const bt = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0;
      if (bt !== at) return bt - at;
      return a.key.localeCompare(b.key);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * How long a freshly shared document is left alone before it can be called quiet.
 *
 * The section header used to read "no opens in 90 days" over eight rows that all said "shared 2
 * hours ago" — sorted newest-first, the freshest documents crowded out every genuinely stale one,
 * and a document sent this morning is not a document that has gone quiet. A day is the grace an
 * unopened deck gets before it is worth a nudge.
 */
export const QUIET_DOC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Shared documents nobody opened in the range, newest share first.
 *
 * Newest first on purpose: a deck sent last week and still unopened is a nudge worth sending today,
 * while one shared last year is not news. Two rows never reach the list at all: a document with no
 * live link (`sharedAt: null` — nothing to open, so nothing to chase), and one shared inside
 * {@link QUIET_DOC_GRACE_MS}, which has not had a fair chance yet.
 */
export function selectQuietDocs(
  shared: Array<{ docId: string; title: string; sharedAt: string | null }>,
  openedDocIds: Set<string>,
  limit: number,
  now: number = Date.now(),
): WorkspaceQuietDoc[] {
  const cutoff = now - QUIET_DOC_GRACE_MS;
  return shared
    .filter((d) => !openedDocIds.has(d.docId))
    .filter((d) => {
      if (!d.sharedAt) return false;
      const at = Date.parse(d.sharedAt);
      return Number.isFinite(at) && at <= cutoff;
    })
    .sort((a, b) => {
      const at = a.sharedAt ? Date.parse(a.sharedAt) : 0;
      const bt = b.sharedAt ? Date.parse(b.sharedAt) : 0;
      if (bt !== at) return bt - at;
      return a.docId.localeCompare(b.docId);
    })
    .slice(0, Math.max(0, limit))
    .map((d) => ({ docId: d.docId, title: d.title, sharedAt: d.sharedAt, href: docMetricsHref(d.docId) }));
}
