/**
 * AdminTable — the dense, one-line-per-row table every admin list uses.
 *
 * The wrapper owns density and alignment so a page cannot drift: cells never wrap,
 * numeric columns are tabular and right-aligned, headers are one line. A page supplies
 * `head` (the `<th>`s) and rows as children.
 *
 *   <AdminTable head={<><AdminTh>Email</AdminTh><AdminTh align="right">Created</AdminTh></>}>
 *     {rows.map((r) => (
 *       <AdminTr key={r.id}>
 *         <AdminTd primary>{r.email}</AdminTd>
 *         <AdminTd align="right" numeric>{fmtAdminDateTime(r.createdAt)}</AdminTd>
 *       </AdminTr>
 *     ))}
 *   </AdminTable>
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import {
  ADMIN_ACTIONS_CELL_Y,
  ADMIN_CELL_TEXT,
  ADMIN_CELL_X,
  ADMIN_CELL_Y,
  ADMIN_HEAD_TEXT,
  ADMIN_STICKY_EDGE,
  ADMIN_TRUNCATE_WRAP,
  alignClass,
  type AdminAlign,
} from "@/lib/admin/ui";

export type AdminTableProps = {
  /** The header cells: a fragment of `<AdminTh>` elements. */
  head: React.ReactNode;
  /** `<AdminTr>` rows. */
  children: React.ReactNode;
  /** Accessible name for the table. */
  ariaLabel?: string;
  className?: string;
};

/**
 * The admin list table: dense, one line per row, horizontally scrollable when needed.
 *
 * At phone width a table with a sticky actions column used to look like corrupted data:
 * the pinned column covered the identity column and nothing said the row scrolled. The
 * scroller therefore reports its own overflow — a fading edge appears on whichever side
 * has more content, and disappears at the end of the travel.
 */
export default function AdminTable({ head, children, ariaLabel, className }: AdminTableProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft > 1;
    const end = max > 1 && el.scrollLeft < max - 1;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const firstChild = el.firstElementChild;
    if (firstChild) ro?.observe(firstChild);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, children]);

  return (
    <div
      className={cn("relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]", className)}
    >
      <div ref={scrollerRef} className="overflow-x-auto">
        <table aria-label={ariaLabel} className="min-w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--panel-2)]">{head}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
        </table>
      </div>
      {/* Scroll affordance: "there is more this way", drawn from the panel's own colour. */}
      <span
        aria-hidden="true"
        hidden={!overflow.start}
        className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--panel)] to-transparent"
      />
      <span
        aria-hidden="true"
        hidden={!overflow.end}
        className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--panel)] to-transparent"
      />
    </div>
  );
}

export type AdminThProps = React.ComponentPropsWithoutRef<"th"> & {
  align?: AdminAlign;
  /** Fixed column width, e.g. "w-[120px]". */
  width?: string;
  /** Pin this column to the right edge so row actions stay reachable on a narrow window. */
  sticky?: boolean;
};

/** A header cell: 11px caps, one line, aligned with its column's body cells. */
export function AdminTh({ align = "left", width, sticky = false, className, children, ...rest }: AdminThProps) {
  return (
    <th
      scope="col"
      className={cn(
        ADMIN_CELL_X,
        ADMIN_HEAD_TEXT,
        alignClass(align),
        "whitespace-nowrap py-2 text-[var(--muted-2)]",
        sticky && cn("sticky right-0 z-10 border-l border-[var(--border)] bg-[var(--panel-2)]", ADMIN_STICKY_EDGE),
        width,
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export type AdminTrProps = React.ComponentPropsWithoutRef<"tr">;

/** A body row. Hover is a surface change only — never a colour. */
export function AdminTr({ className, ...rest }: AdminTrProps) {
  return <tr className={cn("group transition-colors hover:bg-[var(--panel-hover)]", className)} {...rest} />;
}

export type AdminTdProps = React.ComponentPropsWithoutRef<"td"> & {
  align?: AdminAlign;
  /** Tabular figures; pair with `align="right"` for anything countable. */
  numeric?: boolean;
  /** The row's identity cell: full-strength text, medium weight. */
  primary?: boolean;
  /** Mono type for ids, slugs and hashes. */
  mono?: boolean;
  /**
   * Let this cell truncate instead of widening the table, e.g. "max-w-[240px]".
   *
   * The wrapper ellipsises inline text on its own; a *block or inline-block* child (a
   * `<button>`, an `inline-flex` span) is an atomic box, so `text-overflow` cannot reach
   * inside it and it would be sliced mid-glyph. `ADMIN_TRUNCATE_WRAP` therefore also caps
   * and truncates every direct element child. A cell whose child is itself a flex row
   * (name + pill) must still put `truncate` on the *text* span inside it — the pill is a
   * sibling, and an ellipsis cannot be drawn across two flex items.
   */
  truncate?: string;
  /** Pin this cell to the right edge. Use on the actions column, matching its `<AdminTh sticky>`. */
  sticky?: boolean;
  /**
   * This cell holds a `RowActions` group.
   *
   * `ADMIN_CELL_Y` is tuned for a 20px line of text; a 26px button inside the same padding
   * makes the row 46px, so the actions column — not the type — was setting the rhythm of
   * every table that has one. Tighter vertical padding here puts the documented 40px row
   * back, and keeps a table with actions on the same pitch as one without.
   */
  actions?: boolean;
};

/** A body cell. Never wraps; long text truncates with a `title` supplied by the page. */
export function AdminTd({
  align = "left",
  numeric = false,
  primary = false,
  mono = false,
  truncate,
  sticky = false,
  actions = false,
  className,
  children,
  ...rest
}: AdminTdProps) {
  return (
    <td
      className={cn(
        ADMIN_CELL_X,
        actions ? ADMIN_ACTIONS_CELL_Y : ADMIN_CELL_Y,
        ADMIN_CELL_TEXT,
        alignClass(align),
        "whitespace-nowrap align-middle",
        numeric && "tabular-nums",
        mono && "font-mono text-[12px]",
        primary ? "font-medium text-[var(--fg)]" : "text-[var(--muted)]",
        sticky &&
          cn(
            "sticky right-0 z-10 border-l border-[var(--border)] bg-[var(--panel)] transition-colors group-hover:bg-[var(--panel-hover)]",
            ADMIN_STICKY_EDGE,
          ),
        truncate,
        className,
      )}
      {...rest}
    >
      {truncate ? <div className={ADMIN_TRUNCATE_WRAP}>{children}</div> : children}
    </td>
  );
}

/** The row shown when a list has nothing in it. Always says *why* it is empty. */
export function AdminTableEmpty({
  colSpan,
  title,
  hint,
}: {
  colSpan: number;
  /** e.g. "No users match that search" */
  title: string;
  /** Optional second line: what to do about it. */
  hint?: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center">
        <div className="text-[13px] font-medium text-[var(--fg)]">{title}</div>
        {hint ? <div className="mt-1 text-[12px] text-[var(--muted-2)]">{hint}</div> : null}
      </td>
    </tr>
  );
}

/** A quiet full-width row: loading, or an error that belongs inside the table. */
export function AdminTableMessage({
  colSpan,
  children,
}: {
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-[13px] text-[var(--muted-2)]">
        {children}
      </td>
    </tr>
  );
}
