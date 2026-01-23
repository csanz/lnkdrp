/**
 * Shared date formatting helpers (UI-safe).
 *
 * IMPORTANT: Keep behavior consistent with existing dashboard UI helpers:
 * - Use the runtime locale (via `toLocaleDateString`).
 * - Provide predictable string fallbacks when parsing fails.
 */

export type FormatShortDateInvalidBehavior = "empty" | "slice10" | "raw";

/**
 * Formats an ISO date string into a short, locale-aware label.
 *
 * Exists for UI consistency across dashboards/tables. On invalid input, behavior is controlled by
 * `opts.invalid` (defaults to returning `iso.slice(0, 10)`).
 */
export function formatShortDate(
  iso: string,
  opts?: { invalid?: FormatShortDateInvalidBehavior },
): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    const behavior = opts?.invalid ?? "slice10";
    if (behavior === "empty") return "";
    if (behavior === "raw") return iso;
    return iso.slice(0, 10);
  }
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Formats a start/end ISO pair into a readable date range label.
 *
 * Falls back to `YYYY-MM-DD to YYYY-MM-DD` when parsing fails.
 */
export function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) {
    return `${start.slice(0, 10)} to ${end.slice(0, 10)}`;
  }
  try {
    return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} - ${e.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`;
  } catch {
    return `${start.slice(0, 10)} to ${end.slice(0, 10)}`;
  }
}

/**
 * Formats a `YYYY-MM` month key into a locale-aware month label.
 *
 * Exists for charts/tables that use stable month bucket keys. Returns the input when parsing fails.
 */
export function formatMonthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-");
  const yy = Number(y);
  const mm = Number(m);
  if (!Number.isFinite(yy) || !Number.isFinite(mm)) return yyyyMm;
  const d = new Date(Date.UTC(yy, Math.max(0, mm - 1), 1));
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
  } catch {
    return yyyyMm;
  }
}


