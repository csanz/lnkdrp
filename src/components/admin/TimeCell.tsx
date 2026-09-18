/**
 * TimeCell — a timestamp on one line, with the full value in `title`.
 *
 * `17 Sep 2026, 10:59` instead of `9/17/2026, 10:59:52 AM` wrapped over two lines.
 * Pair with `<AdminTd align="right" numeric>` so a column of them lines up.
 */
"use client";

import { ADMIN_DASH, fmtAdminDate, fmtAdminDateFull, fmtAdminDateTime } from "@/lib/admin/ui";

export type TimeCellProps = {
  value: string | number | Date | null | undefined;
  /** "datetime" (default) or "date" when the time of day is noise. */
  mode?: "datetime" | "date";
  className?: string;
};

/** A timestamp on one line, with the full local value in `title`. */
export default function TimeCell({ value, mode = "datetime", className }: TimeCellProps) {
  const text = mode === "date" ? fmtAdminDate(value) : fmtAdminDateTime(value);
  if (!text) return <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>;
  return (
    <span className={className} title={fmtAdminDateFull(value)}>
      {text}
    </span>
  );
}
