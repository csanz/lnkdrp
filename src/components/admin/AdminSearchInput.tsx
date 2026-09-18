/**
 * AdminSearchInput — the search field used in every admin filter band.
 *
 * A magnifier on the left, a clear button once there is text. `onValueChange` hands
 * back the string so pages stop writing `e.target.value` and resetting the page number
 * in five different ways.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_FOCUS_RING_BAND } from "@/lib/admin/ui";

export type AdminSearchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; defaults to the placeholder. */
  ariaLabel?: string;
  className?: string;
};

/** The search field for an admin filter band: magnifier, 32px tall, clearable. */
export default function AdminSearchInput({
  value,
  onValueChange,
  placeholder = "Search…",
  ariaLabel,
  className,
}: AdminSearchInputProps) {
  return (
    <div className={cn("relative w-[260px] max-w-full", className)}>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-2)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] pl-8 pr-7 text-[13px] leading-5 text-[var(--fg)] placeholder:text-[var(--muted-2)] [&::-webkit-search-cancel-button]:hidden",
          ADMIN_FOCUS_RING_BAND,
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange("")}
          className={cn(
            "absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            ADMIN_FOCUS_RING_BAND,
          )}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
