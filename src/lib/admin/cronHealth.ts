/**
 * Cron heartbeat vocabulary, shared by `/a` and `/a/cron-health`.
 *
 * Both pages read the same snapshot endpoint and have to agree on what a job's state looks
 * like and how its counters read as one line; the two used to carry their own copies of this
 * and drifted (one coloured every healthy job green, the other did not).
 */

import type { AdminTone } from "./ui";

export type CronHealthItem = {
  jobKey: string;
  status?: "ok" | "running" | "error" | null;
  lastRunAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
  lastResult?: unknown;
};

/**
 * A job's state as a tone. `ok` is the boring case and stays `quiet` — a column of green ticks
 * is decoration, and the one row that is failing has to be the only coloured thing on screen.
 */
export function cronTone(status: CronHealthItem["status"]): AdminTone {
  if (status === "error") return "danger";
  if (status === "running") return "info";
  return "quiet";
}

/** A JSON object, as opposed to an array or a primitive. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A real number, or null for anything a counter cannot be. */
function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `linksChecked` → `links checked`: a counter key a reader does not have to decode. */
function humanKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

export type CronStat = { label: string; value: string; zero: boolean };

/**
 * The counters worth showing beside a job, as labelled figures.
 *
 * The raw line was a wall of camelCase with a different key set per row, and the interesting
 * number — the one that is not zero — was as likely to be cut off as printed. Counters that did
 * something come first, `dryRun: false` and the zeros fall to the back, and the caller shows the
 * first few and keeps the full line in a `title`.
 */
export function cronStatsFigures(item: CronHealthItem): CronStat[] {
  if (!isPlainObject(item.lastResult)) return [];
  const out: CronStat[] = [];
  for (const [k, v] of Object.entries(item.lastResult)) {
    // `docIds` is a payload, not a counter; `ok` is the Status column said twice.
    if (k === "docIds" || k === "ok") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ label: humanKey(k), value: String(v), zero: v === 0 });
    } else if (typeof v === "boolean") {
      out.push({ label: humanKey(k), value: v ? "yes" : "no", zero: !v });
    } else if (typeof v === "string" && v.trim()) {
      out.push({ label: humanKey(k), value: v.trim(), zero: false });
    }
  }
  // Stable within each group: what happened first, then the quiet zeros.
  return [...out.filter((s) => !s.zero), ...out.filter((s) => s.zero)];
}

/**
 * The counters a job wrote on its last run, folded to one line.
 *
 * Returns null when the snapshot carries nothing printable, so the caller renders a dash
 * rather than an empty cell.
 */
export function formatCronStatsLine(item: CronHealthItem): string | null {
  if (!isPlainObject(item.lastResult)) return null;
  const r = item.lastResult;

  // Special case: doc metrics rollup.
  if (item.jobKey === "doc-metrics") {
    const processed = asFiniteNumber(r.processed);
    const days = asFiniteNumber(r.days);
    const views = asFiniteNumber(r.viewsLastDaysTotal);
    const downloads = asFiniteNumber(r.downloadsLastDaysTotal);
    const downloadsTotal = asFiniteNumber(r.downloadsTotalTotal);

    const parts: string[] = [];
    if (processed !== null) parts.push(`docs: ${processed}`);
    if (views !== null && days !== null) parts.push(`views (${days}d): ${views}`);
    else if (views !== null) parts.push(`views: ${views}`);
    if (downloads !== null && days !== null) parts.push(`downloads (${days}d): ${downloads}`);
    else if (downloads !== null) parts.push(`downloads: ${downloads}`);
    if (downloadsTotal !== null) parts.push(`downloads total: ${downloadsTotal}`);

    return parts.length ? parts.join(" • ") : null;
  }

  // Generic: a few primitive values from lastResult, never a huge field.
  const omitKeys = new Set(["docIds"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (omitKeys.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}: ${v}`);
    else if (typeof v === "boolean") parts.push(`${k}: ${v ? "true" : "false"}`);
    else if (typeof v === "string" && v.trim()) parts.push(`${k}: ${v.trim()}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(" • ") : null;
}
