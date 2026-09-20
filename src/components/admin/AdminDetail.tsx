/**
 * AdminDetail — the shapes a detail page is built from.
 *
 * A list page is a header, a filter band and a table. A detail page is a header and a
 * stack of *panels*: some hold label/value pairs, some hold a table, some hold raw JSON.
 * These components own that rhythm so no page restates it:
 *
 * - `DetailPanel`  a titled box. Its title band matches a table header band, so panels
 *                  and tables read as the same material down the page.
 * - `DetailGrid`   the label/value list inside a panel (one or two columns).
 * - `DetailRow`    one label/value line: fixed label column, muted label, em dash when
 *                  the value is missing. Never a wrapped label, never a bare blank.
 * - `DetailSection` the heading above a full-width table on a detail page.
 * - `StatTile`     one number in the summary strip.
 * - `JsonBlock`    a raw JSON dump that scrolls instead of stretching the page.
 *
 * Everything is `--fg` / `--muted` / `--panel` tokens: correct in light, dark and
 * system-dark without a `dark:` variant.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_DASH, ADMIN_HEAD_TEXT, toneTextStyle, type AdminTone } from "@/lib/admin/ui";

/* ---------------------------------------------------------------------- panel */

export type DetailPanelProps = {
  /** What this panel is: "Identity", "Plan and subscription", "Memberships". */
  title: string;
  /** Optional one-line note under the title. */
  description?: React.ReactNode;
  /** Controls pinned to the right of the title band. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Padding for the body. Override when the body is a table or a JSON block. */
  bodyClassName?: string;
};

/** A titled panel. The title band is the same material as a table's header row. */
export default function DetailPanel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: DetailPanelProps) {
  return (
    <section
      className={cn("min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-card)]", className)}
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
        <div className="min-w-0">
          <h2 className={cn(ADMIN_HEAD_TEXT, "truncate text-[var(--muted-2)]")}>{title}</h2>
          {description ? (
            <p className="mt-0.5 truncate text-[12px] leading-4 text-[var(--muted-2)]">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      {/* 2px here + 10px on a row lines every value up with the 12px title above it. */}
      <div className={bodyClassName ?? "px-0.5 py-2"}>{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------------- label/value */

export type DetailGridProps = {
  /** Two columns on a wide screen for a long list of short values. */
  columns?: 1 | 2;
  children: React.ReactNode;
  className?: string;
};

/** The label/value list inside a panel. */
export function DetailGrid({ columns = 1, children, className }: DetailGridProps) {
  return (
    <dl className={cn("grid gap-x-6", columns === 2 && "md:grid-cols-2", className)}>{children}</dl>
  );
}

export type DetailRowProps = {
  /** Sentence case, no trailing colon — the column edge does that job. */
  label: string;
  /** The value. `null`, `undefined` and `""` render an em dash. */
  children?: React.ReactNode;
  /** Full text for a value that may be clipped. */
  title?: string;
  className?: string;
};

/** One label/value line, on the same rhythm on every admin detail page. */
export function DetailRow({ label, children, title, className }: DetailRowProps) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,150px)_minmax(0,1fr)] items-baseline gap-x-3 px-2.5 py-[5px] text-[13px] leading-5",
        className,
      )}
    >
      <dt className="truncate text-[var(--muted-2)]" title={label}>
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[var(--fg)]" title={title}>
        {empty ? <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span> : children}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------- section */

export type DetailSectionProps = {
  /** What the table below is: "Recent credit ledger", "Members". */
  title: string;
  /** One line saying what is in it, or what it is capped at. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

/** The heading above a full-width table on a detail page. */
export function DetailSection({ title, description, actions, className }: DetailSectionProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-1", className)}>
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold leading-5 text-[var(--fg)]">{title}</h2>
        {description ? <p className="text-[12px] leading-4 text-[var(--muted-2)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- stat */

export type StatTileProps = {
  label: string;
  /** Pre-formatted: these are read, not computed. */
  value: string;
  /** The second line — what the number excludes, or what it is measured against. */
  hint?: string;
  /** Colour only when the number itself is the exception (over a cap, failing). */
  tone?: AdminTone;
};

/** One number in a detail page's summary strip. */
export function StatTile({ label, value, hint, tone }: StatTileProps) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5">
      <div className={cn(ADMIN_HEAD_TEXT, "truncate text-[var(--muted-2)]")} title={label}>
        {label}
      </div>
      <div
        className="mt-1 truncate text-[18px] font-semibold leading-6 tabular-nums text-[var(--fg)]"
        style={tone ? toneTextStyle(tone) : undefined}
        title={value}
      >
        {value}
      </div>
      {/* Always a second line, so a strip of tiles keeps one baseline. */}
      <div className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--muted-2)]" title={hint}>
        {hint ?? " "}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- json */

export type JsonBlockProps = {
  /** Already-stringified text, or a value to pretty-print. */
  text: string;
  /** Copy buttons and the like, shown above the block. */
  actions?: React.ReactNode;
  /** Tailwind max-height class; the block scrolls rather than stretching the page. */
  maxHeight?: string;
  className?: string;
};

/** A raw JSON (or raw text) dump that scrolls inside its own bordered box. */
export function JsonBlock({ text, actions, maxHeight = "max-h-[320px]", className }: JsonBlockProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-2)]", className)}>
      {actions ? (
        <div className="flex items-center justify-end gap-1.5 border-b border-[var(--border)] px-2 py-1.5">
          {actions}
        </div>
      ) : null}
      <pre
        className={cn(
          "overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-5 text-[var(--muted)]",
          maxHeight,
        )}
      >
        {text}
      </pre>
    </div>
  );
}
