/**
 * Duration, gap and date wording shared by the metrics page and reader sheet. All values floor.
 */

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

/** "5 minutes", "1 hour", "2 days". */
export function formatGap(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 3_600_000) return plural(Math.max(1, Math.floor(safe / 60_000)), "minute", "minutes");
  if (safe < 86_400_000) return plural(Math.floor(safe / 3_600_000), "hour", "hours");
  return plural(Math.floor(safe / 86_400_000), "day", "days");
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else "Sep 10" (", 2025" in another year). */
export function formatRelative(isoOrMs: string | number | Date, now: number): string {
  const t = isoOrMs instanceof Date ? isoOrMs.getTime() : typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 2 * 86_400_000) return "yesterday";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} days ago`;
  const d = new Date(t);
  const base = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
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
