/**
 * RowActions — every row's controls, in one group, at the right.
 *
 * `RowActions` is the group; `RowAction` is the button inside it. All row buttons are
 * the same height (26px) and the same type size, so a column of them is a straight
 * edge. A destructive action uses `tone="danger"` and sits last.
 */
"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { ADMIN_FOCUS_RING, ADMIN_ROW_ACTION_LINK, toneTextStyle, type AdminTone } from "@/lib/admin/ui";

export type RowActionsProps = {
  children: React.ReactNode;
  className?: string;
};

/** The right-aligned group holding a row's action buttons. */
export default function RowActions({ children, className }: RowActionsProps) {
  return <div className={cn("flex items-center justify-end gap-1.5", className)}>{children}</div>;
}

export type RowActionProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  children: React.ReactNode;
  /** `danger` tints the label only — never the whole button. */
  tone?: Extract<AdminTone, "neutral" | "danger">;
  /** Shows a quiet busy label in place of the children. */
  busy?: boolean;
  busyLabel?: string;
};

/** One button inside a `RowActions` group; all row buttons share this height and size. */
export function RowAction({
  children,
  tone = "neutral",
  busy = false,
  busyLabel = "Working…",
  className,
  disabled,
  ...rest
}: RowActionProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      style={tone === "danger" && !disabled && !busy ? toneTextStyle("danger") : undefined}
      className={cn(
        "inline-flex h-[26px] items-center justify-center whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] font-medium leading-4 text-[var(--muted)] transition",
        "hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
        ADMIN_FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[var(--panel)]",
        className,
      )}
      {...rest}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

export type RowActionLinkProps = Omit<React.ComponentPropsWithoutRef<typeof Link>, "className"> & {
  children: React.ReactNode;
  className?: string;
};

/**
 * A row action that navigates.
 *
 * `RowAction` is a `<button>`; an action that opens a page has to be an anchor so it can be
 * middle-clicked or opened in a new tab. Same 26px box, same type, same states, so a group
 * mixing the two is still one straight edge.
 */
export function RowActionLink({ children, className, ...rest }: RowActionLinkProps) {
  return (
    <Link className={cn(ADMIN_ROW_ACTION_LINK, className)} {...rest}>
      {children}
    </Link>
  );
}
