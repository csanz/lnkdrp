/**
 * Shared date formatting helpers (UI-safe).
 *
 * IMPORTANT: Keep behavior consistent with existing dashboard UI helpers:
 * - Use the runtime locale (via `toLocaleDateString`).
 * - Provide predictable string fallbacks when parsing fails.
 */

export type FormatShortDateInvalidBehavior = "empty" | "slice10" | "raw";

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


