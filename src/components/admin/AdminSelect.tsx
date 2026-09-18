/**
 * AdminSelect — a select sized to the admin filter band (32px tall, 13px text).
 *
 * The app-wide `ui/Select` is a form control: taller, rounder, and it makes the band
 * look like a form. This is the same element with band metrics.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_FOCUS_RING_BAND } from "@/lib/admin/ui";

export type AdminSelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "size"> & {
  /** Accessible name. Required: a bare select in a filter band has no visible label. */
  ariaLabel: string;
};

/** A `<select>` sized for the admin filter band. Always give it an accessible name. */
export default function AdminSelect({ ariaLabel, className, ...props }: AdminSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      title={props.title ?? ariaLabel}
      className={cn(
        "h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 text-[13px] leading-5 text-[var(--fg)]",
        ADMIN_FOCUS_RING_BAND,
        className,
      )}
      {...props}
    />
  );
}
