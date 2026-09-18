/**
 * SegmentedAction — a small set of mutually exclusive one-click actions.
 *
 * Replaces stacks of "Set X" / "Set Y" buttons inside a data cell: one control, the
 * current value visibly selected, one click to change it. It fires immediately — it is
 * an action group, not a form input, so there is no confirm and no save step.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_FOCUS_RING_INSET } from "@/lib/admin/ui";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Tooltip; defaults to the label. */
  title?: string;
};

export type SegmentedActionProps<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  /** The currently selected value; rendered as pressed. */
  value: T | null;
  onSelect: (value: T) => void;
  /** Accessible name for the group, e.g. "Plan for alice@example.com". */
  ariaLabel: string;
  disabled?: boolean;
  /** Shows a busy state across the group (e.g. while the write is in flight). */
  busy?: boolean;
  className?: string;
};

/** A joined set of one-click, mutually exclusive actions (e.g. plan Free | Pro). */
export default function SegmentedAction<T extends string>({
  options,
  value,
  onSelect,
  ariaLabel,
  disabled = false,
  busy = false,
  className,
}: SegmentedActionProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex h-[26px] items-stretch overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]",
        className,
      )}
    >
      {options.map((opt, i) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            title={opt.title ?? opt.label}
            disabled={disabled || busy}
            onClick={() => onSelect(opt.value)}
            className={cn(
              "inline-flex min-w-[38px] items-center justify-center px-2 text-[12px] font-medium leading-4 transition",
              i > 0 && "border-l border-[var(--border)]",
              selected
                ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
              ADMIN_FOCUS_RING_INSET,
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
