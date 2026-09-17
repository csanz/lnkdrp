/**
 * Duration, gap, ratio and date wording shared by the metrics page and reader sheet. Values floor;
 * return gaps of a day or more count calendar days in the viewer's time zone.
 */
import { dayKeyInZone } from "./days";

/** "28s", "1m 39s", "10m", "1h 5m"; "—" for null. */
export function formatDwell(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms <= 0) return "0s";
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Single-unit form for narrow cells: "<1s", "12s", "4m", "2h"; "—" for null. */
export function formatDwellCompact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "5 minutes", "1 hour", "3 days". Minutes and hours floor; days round. Prefer formatReturnGap for copy next to dates. */
export function formatGap(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 3_600_000) return plural(Math.max(1, Math.floor(safe / 60_000)), "minute", "minutes");
  if (safe < 86_400_000) return plural(Math.floor(safe / 3_600_000), "hour", "hours");
  return plural(Math.round(safe / 86_400_000), "day", "days");
}

/**
 * "12 minutes later", "14 hours later", "the next day", "3 days later". A day or more apart counts the
 * calendar days between the two instants in `tz` (default: this runtime's zone), so it agrees with the
 * visit dates shown beside it.
 */
export function formatReturnGap(fromMs: number, toMs: number, tz?: string): string {
  const elapsed = Number.isFinite(toMs - fromMs) ? Math.max(0, toMs - fromMs) : 0;
  if (elapsed < 3_600_000) return `${plural(Math.max(1, Math.floor(elapsed / 60_000)), "minute", "minutes")} later`;
  if (elapsed < 86_400_000) return `${plural(Math.floor(elapsed / 3_600_000), "hour", "hours")} later`;
  const days = calendarDaysBetween(fromMs, toMs, tz);
  return days <= 1 ? "the next day" : `${days} days later`;
}

function resolveZone(tz?: string): string {
  return tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Calendar days from `fromMs` to `toMs` in `tz` (default: this runtime's zone). */
export function calendarDaysBetween(fromMs: number, toMs: number, tz?: string): number {
  const zone = resolveZone(tz);
  return Math.round(
    (Date.parse(`${dayKeyInZone(toMs, zone)}T00:00:00.000Z`) - Date.parse(`${dayKeyInZone(fromMs, zone)}T00:00:00.000Z`)) / 86_400_000,
  );
}

/** Dwell against a typical time, floored to one decimal. Multiplies first so 40000/4000 is 10, not 9.9. */
export function dwellRatio(ms: number, typicalMs: number): number {
  return Math.floor((ms * 10) / typicalMs) / 10;
}

/**
 * "just now", "5 min ago", "3 h ago", then calendar days in `tz` (default: this runtime's zone) so it
 * agrees with the day charts beside it: "yesterday", "4 days ago", else "Sep 10" (", 2025" in another year).
 */
export function formatRelative(isoOrMs: string | number | Date, now: number, tz?: string): string {
  const t = isoOrMs instanceof Date ? isoOrMs.getTime() : typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const zone = resolveZone(tz);
  const days = calendarDaysBetween(t, now, zone);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const base = new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });
  const year = dayKeyInZone(t, zone).slice(0, 4);
  return year === dayKeyInZone(now, zone).slice(0, 4) ? base : `${base}, ${year}`;
}

/** "3 of 4". */
export function formatCountOf(n: number, of: number): string {
  return `${n} of ${of}`;
}

/** "7 days", "30 days", "90 days", "12 months". */
export function rangeLabel(days: number): string {
  if (days === 365) return "12 months";
  return `${days} days`;
}
