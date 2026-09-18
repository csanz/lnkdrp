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

/**
 * The **project** metrics page, filtered to one project link.
 *
 * A project link's `shareId` is not a link of any one document, and `/doc/:docId/metrics` refuses
 * it (that route scopes itself to the document's own links, so `?shareId=<project link>` answers
 * 404). `/project/:projectId/metrics` is the page that owns this traffic; it reads `?shareId=` the
 * same way.
 */
export function projectLinkMetricsHref(projectId: string, shareId: string): string {
  return `/project/${projectId}/metrics?shareId=${encodeURIComponent(shareId)}`;
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

/**
 * One link's traffic in the window, as the aggregation produces it: already collapsed to one row
 * per `shareId`, whether it is a document link or a project link.
 *
 * `docIds` is every live document the link was opened on — one for a document link, one per
 * document opened for a project link.
 *
 * The two counts are **different questions**, and only a project link can tell them apart:
 * - `rows` is `ShareView` rows, which for a project link is (viewer × document opened).
 * - `readers` is distinct readers of the *link*, with the `docId` a project link spells into its
 *   viewer key stripped back off (`linkReaderKeyExpr`).
 *
 * On a document link they are the same number — a row already is one (link, viewer).
 */
export type WorkspaceLinkCandidate = {
  shareId: string;
  docIds: string[];
  rows: number;
  readers: number;
  lastOpenedAt: string | null;
};

/**
 * What the `ShareLink` row (and, for a project link, its project) says about a ranked candidate.
 *
 * Every field is optional and loosely typed because this is the join of a lean Mongo read: a link
 * can have been hard-deleted since its views were recorded, and a project can have been deleted out
 * from under its link.
 */
export type WorkspaceLinkIdentity = {
  shareLinkId?: string | null;
  /** `ShareLink.kind`. Anything other than `"project"` — including missing — is a document link. */
  kind?: string | null;
  label?: string | null;
  audience?: string | null;
  isDefault?: boolean;
  docId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
};

/** The name a project link falls back to when its project row is gone. */
const UNNAMED_PROJECT = "Project";

/** A trimmed string, or `""` — the lean Mongo rows these helpers join can hold anything. */
function cleanText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Top links by views, bounded. Kind-blind on purpose: a row ranks on its traffic, not its type. */
export function rankTopLinks<T extends { shareId: string; views: number; viewers: number; lastOpenedAt: string | null }>(
  rows: T[],
  limit: number,
): T[] {
  return [...rows].sort((a, b) => byViewsThenRecency(a, b, (r) => r.shareId)).slice(0, Math.max(0, limit));
}

/**
 * Turn one ranked candidate into the row the page renders, using whatever its `ShareLink` says.
 *
 * Three cases, and the difference between them is the whole point of this helper:
 *
 * - **A project link** (`kind: "project"` with a `projectId`) is named by its own label, sits under
 *   the *project*, and opens the project's metrics page filtered to it. It never carries a `docId`:
 *   its traffic spans several documents, so naming one of them would be a coin toss, and
 *   `/doc/:docId/metrics?shareId=` answers 404 for a link the document does not own.
 * - **A document link** keeps exactly the old behaviour: the link's document, the document's title
 *   underneath, the document's metrics page filtered to the link.
 * - **A link whose row is gone** (hard-deleted) has no label and no kind to read, so it is treated
 *   as a document link on the document its views were recorded against — the document title is then
 *   the only honest name left for it. A deleted *project* link lands here too and still produces
 *   exactly one row, which is what keeps the list free of duplicate `shareId`s.
 *
 * **A project link's `views` are its recipients, never its rows.** That is the locked rule
 * (docs/METRICS.md, "Views for a project link are not `countDocuments({ shareId })`"), and it is
 * also the only value that agrees with the page this row opens: `GET /api/projects/:id/shareviews`
 * groups on `PROJECT_LINK_VIEWER_KEY_EXPR` before counting, so one investor who read a deck and a
 * term sheet through one data-room link is one view there and must be one view here. Summing the
 * rows instead reports a two-document data room as twice the traffic it had. Document links are
 * unaffected: a row already is one (link, viewer), so `rows` and `readers` agree.
 */
export function buildTopLink(
  row: WorkspaceLinkCandidate,
  identity: WorkspaceLinkIdentity | null | undefined,
  docTitle: (docId: string) => string,
): WorkspaceTopLink {
  const shareLinkId = cleanText(identity?.shareLinkId) || null;
  const audience = cleanText(identity?.audience) || null;
  const isDefault = identity?.isDefault === true;
  const label = cleanText(identity?.label);
  const projectId = cleanText(identity?.projectId);

  if (cleanText(identity?.kind) === "project" && projectId) {
    const parentName = cleanText(identity?.projectName) || UNNAMED_PROJECT;
    return {
      shareId: row.shareId,
      shareLinkId,
      kind: "project",
      label: label || parentName,
      audience,
      isDefault,
      docId: null,
      projectId,
      parentName,
      views: safeCount(row.readers),
      viewers: safeCount(row.readers),
      lastOpenedAt: row.lastOpenedAt,
      href: projectLinkMetricsHref(projectId, row.shareId),
    };
  }

  // `identity.docId` first — the link's own document — falling back to the document its views were
  // recorded against, which is all a deleted link leaves behind.
  const docId = cleanText(identity?.docId) || cleanText(row.docIds[0]);
  const parentName = docTitle(docId);
  return {
    shareId: row.shareId,
    shareLinkId,
    kind: "doc",
    label: label || parentName,
    audience,
    isDefault,
    docId,
    projectId: null,
    parentName,
    views: safeCount(row.rows),
    viewers: safeCount(row.readers),
    lastOpenedAt: row.lastOpenedAt,
    href: linkMetricsHref(docId, row.shareId),
  };
}

/**
 * {@link buildTopLink} over every candidate, then ranked and bounded.
 *
 * Named **before** ranked, not after, which is the order the first cut used: a project link's views
 * are its recipients rather than its rows, and only its `ShareLink` says it is one, so ranking the
 * raw candidates would order the card by a figure two of its rows do not print.
 */
export function buildTopLinks(
  rows: WorkspaceLinkCandidate[],
  identityOf: (shareId: string) => WorkspaceLinkIdentity | null | undefined,
  docTitle: (docId: string) => string,
  limit: number,
): WorkspaceTopLink[] {
  return rankTopLinks(
    rows.map((row) => buildTopLink(row, identityOf(row.shareId), docTitle)),
    limit,
  );
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
