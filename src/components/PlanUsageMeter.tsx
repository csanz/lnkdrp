/**
 * PlanUsageMeter — a labelled thin bar for one plan limit ("Links 2 of 3").
 *
 * Used by the left sidebar (Free plan block) and the dashboard Plan card. `used` may be `null`
 * while the plan snapshot is still loading; the row then keeps its height and shows an empty bar,
 * so the surrounding layout never jumps once numbers arrive. `warn` switches to the amber tone
 * (used when the workspace is at its link limit). Bar width animates only when motion is allowed.
 */
import { cn } from "@/lib/cn";

type Props = {
  label: string;
  /** Current usage; `null` while unknown. */
  used: number | null;
  /** Plan cap; `null` means unlimited. */
  max: number | null;
  /** Amber tone (at limit). */
  warn?: boolean;
  /** Tighter type for narrow containers (sidebar). */
  compact?: boolean;
  className?: string;
};

/** Render a single usage meter row. */
export default function PlanUsageMeter({ label, used, max, warn = false, compact = false, className }: Props) {
  const fraction = used === null || max === null || max <= 0 ? 0 : Math.min(1, used / max);
  const value = used === null ? "—" : max === null ? `${used}` : `${used} of ${max}`;
  const pct = `${Math.round(fraction * 100)}%`;
  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-2 leading-4",
          compact ? "text-[11px]" : "text-[12px]",
          warn ? "text-amber-700 dark:text-amber-300" : "text-[var(--muted-2)]",
        )}
      >
        <span className="truncate">{label}</span>
        <span className={cn("shrink-0 tabular-nums", warn ? "font-semibold" : "text-[var(--muted)]")}>{value}</span>
      </div>
      <div
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={used ?? undefined}
        aria-valuetext={value}
      >
        <div
          className={cn(
            "h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300",
            warn ? "bg-amber-500" : "bg-[var(--fg)]",
          )}
          style={{ width: pct }}
        />
      </div>
    </div>
  );
}
