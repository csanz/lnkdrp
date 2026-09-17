/**
 * Wording and tone for the `/metrics` page (docs/prds/lnkdrp-workspace-metrics.md).
 *
 * Pure on purpose: every sentence the page says about a number — the change chip, the "opened 12 of
 * 31 shared" line, the output line — is decided here and unit-tested (tests/lib/workspaceMetricsUi.test.ts)
 * rather than eyeballed on live data. The components below only render what these return.
 */
import { formatDwell } from "@/lib/analytics/reading/format";
import { formatInt } from "@/lib/format/number";
import type { WorkspaceMetricDelta, WorkspaceSeriesPoint } from "@/lib/analytics/workspace/types";

/**
 * The four headline figures; the selected one drives the hero chart.
 *
 * `opens` and not `viewers`: a `shareviews` row is unique per (link, browser), so a viewer count and
 * a view count are the same number on every real payload — two of these four tiles printed 584. An
 * open is a tab session, which is a different fact and the one that makes returning readers
 * visible. Viewers survives per document and per link, where it is not a duplicate.
 */
export type MetricKey = "views" | "opens" | "readingTimeMs" | "downloads";

export const METRIC_KEYS: readonly MetricKey[] = ["views", "opens", "readingTimeMs", "downloads"] as const;

/** Tile label, chart heading and the noun the tooltip uses for one point. */
export const METRIC_META: Record<MetricKey, { label: string; chartTitle: string; unit: string; unitPlural: string }> = {
  views: { label: "Views", chartTitle: "Views per day", unit: "view", unitPlural: "views" },
  opens: { label: "Opens", chartTitle: "Opens per day", unit: "open", unitPlural: "opens" },
  readingTimeMs: { label: "Reading time", chartTitle: "Reading time per day", unit: "", unitPlural: "" },
  downloads: { label: "Downloads", chartTitle: "Downloads per day", unit: "download", unitPlural: "downloads" },
};

/**
 * The tiles a payload may actually show.
 *
 * Opens drops out when the window's visit rows are known to be incomplete (`opensPartial`): the
 * document page withholds the figure on that data rather than print a floor as a count, and so does
 * this one. Three tiles is a fine strip; a tile that lies is not.
 */
export function visibleMetricKeys(opensPartial: boolean): MetricKey[] {
  return METRIC_KEYS.filter((k) => k !== "opens" || !opensPartial);
}

/** True for the one metric measured in milliseconds, which never formats as a count. */
export function isDurationMetric(key: MetricKey): boolean {
  return key === "readingTimeMs";
}

/** A headline value as the tile shows it: a locale integer, or a duration for reading time. */
export function formatMetricValue(key: MetricKey, value: number): string {
  return isDurationMetric(key) ? formatDwell(value) : formatInt(value);
}

/**
 * The same value for a chart's count label.
 *
 * `formatDwell` and never `formatDwellCompact`: the compact form floors to a single unit, so every
 * reading time between an hour and two hours printed "1h" — two visibly different peaks carried the
 * same label and the chart read as broken. Count labels are the whole reason this chart style
 * exists, so they keep the second unit; `formatDwellCompact` stays as it is for the narrow table
 * cells it was written for.
 */
export function formatMetricCompact(key: MetricKey, value: number): string {
  return isDurationMetric(key) ? formatDwell(value) : formatInt(value);
}

/** One point of the selected series, spelled out for the tooltip: "12 views", "4m 12s". */
export function formatMetricPoint(key: MetricKey, value: number): string {
  if (isDurationMetric(key)) return formatDwell(value);
  const meta = METRIC_META[key];
  return `${formatInt(value)} ${value === 1 ? meta.unit : meta.unitPlural}`;
}

/** Pull one metric out of the day series for the chart. */
export function seriesValues(series: WorkspaceSeriesPoint[], key: MetricKey): number[] {
  return series.map((p) => {
    const v = p[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
  });
}

/**
 * How a change against the previous period reads.
 *
 * Three cases the UI must not blur together:
 * - `"none"` — no comparison was served at all (Free gets no previous window), so the tile reserves
 *   the space and says nothing rather than implying the figure is flat.
 * - `"new"` — the previous period was zero. "+∞%" is not a number and "+100%" is a lie.
 * - `"up"` / `"down"` / `"flat"` — a real percentage. Down is muted, never red: fewer views this
 *   week is information, not an error.
 */
export type ChangeTone = "up" | "down" | "flat" | "new" | "none";
export type ChangeChip = { tone: ChangeTone; label: string; caption: string; title: string } | null;

/** The change chip for one headline figure, or `null` when it should say nothing at all. */
export function changeChip(delta: WorkspaceMetricDelta, previousDays: number, metricLabel: string): ChangeChip {
  const caption = `vs previous ${previousDays} days`;
  if (delta.previous === null) return null;
  if (delta.changePct === null) {
    return delta.value > 0
      ? { tone: "new", label: "New", caption, title: `${metricLabel}: nothing in the previous ${previousDays} days` }
      : null;
  }
  const pct = delta.changePct;
  const tone: ChangeTone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  // One decimal only where it says something: "+18%" reads better than "+18.0%".
  const rounded = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return {
    tone,
    label: `${sign}${rounded}%`,
    caption,
    title: `${metricLabel} ${sign}${rounded}% against the previous ${previousDays} days (${formatInt(delta.previous)})`,
  };
}

/**
 * The line under the headline strip: "12 of 31 shared documents were opened · 4 readers came back".
 *
 * Two clauses that only appear when they say something:
 * - documents read that are outside the `shared` denominator (archived, or sharing switched off).
 *   They are in the headline and can be ranked below, so leaving them out made the count quietly
 *   shorter than the list under it;
 * - the returning readers — readers with more than one session in the window, counted as such and
 *   not `opens - views` (see `docsOpened.returningReaders`) — withheld when the visit rows are
 *   incomplete.
 */
export function openedSentence(docsOpened: {
  opened: number;
  shared: number;
  openedOther: number;
  returningReaders: number | null;
}): string {
  const other = Math.max(0, docsOpened.openedOther);
  const returning = docsOpened.returningReaders === null ? 0 : Math.max(0, docsOpened.returningReaders);
  const head =
    `${formatInt(docsOpened.opened)} of ${formatInt(docsOpened.shared)} shared ` +
    `${docsOpened.shared === 1 ? "document was" : "documents were"} opened` +
    (other > 0 ? ` (plus ${formatInt(other)} archived or unshared)` : "");
  if (returning <= 0) return head;
  return `${head} · ${formatInt(returning)} ${returning === 1 ? "reader" : "readers"} came back`;
}

/**
 * "In the last 30 days: 4 documents got their first link · 9 links created · 6 uploads".
 *
 * "got their first link" and not "documents shared": this clause counts every live document whose
 * first link was created in the window, which includes ones since archived or switched off, while
 * the sentence under the headline counts the documents the workspace is sharing *now*. Both said
 * "shared" once, four lines apart, and printed "124 documents shared" above "51 of 104 shared
 * documents were opened" — a reader cannot reconcile that, and it reads as a broken page. The noun
 * here names the event; the other names the state.
 */
export function outputSentence(days: number, output: { docsShared: number; linksCreated: number; uploads: number }): string {
  const parts = [
    `${formatInt(output.docsShared)} ${output.docsShared === 1 ? "document got its" : "documents got their"} first link`,
    `${formatInt(output.linksCreated)} ${output.linksCreated === 1 ? "link" : "links"} created`,
    `${formatInt(output.uploads)} ${output.uploads === 1 ? "upload" : "uploads"}`,
  ];
  return `In the last ${days} days: ${parts.join(" · ")}`;
}

/** "169 people viewed your documents" — the count Free still sees, without any names. */
export function peopleCountSentence(count: number): string {
  return `${formatInt(count)} ${count === 1 ? "person" : "people"} viewed your documents in this period`;
}

/** A link's display name: its label, else the audience it was made for, else the default link. */
export function linkDisplayName(link: { label: string; audience: string | null; isDefault: boolean }): string {
  const label = link.label.trim();
  if (label) return label;
  const audience = (link.audience ?? "").trim();
  if (audience) return audience;
  return link.isDefault ? "Default link" : "Untitled link";
}
