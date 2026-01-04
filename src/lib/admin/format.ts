/**
 * Admin formatting helpers.
 *
 * Keep these tiny and dependency-free so admin pages stay easy to maintain.
 */
/** Format a date-ish string as a user-friendly local time string (best-effort). */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

/** Format a duration in ms as a compact human string (best-effort). */
export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${Math.round(r)}s`;
}


