/**
 * AdminFilterBar — the one band that sits between the page header and the table.
 *
 * Left: the filter controls a page passes as children (search first, then selects).
 * Right: the result range, then Prev/Next, then any page-level extras (Refresh).
 * Pagination is rendered here, not by the page, so every list pages the same way.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_FOCUS_RING_BAND, rangeLabel } from "@/lib/admin/ui";

export type AdminFilterBarProps = {
  /** Filter controls, left to right: AdminSearchInput, then AdminSelects. */
  children?: React.ReactNode;
  /** 1-based current page. Omit page/pageSize/total to hide the range + pager. */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  /** Plural noun for the range label, e.g. "users". */
  noun?: string;
  /** Disables the pager while a fetch is in flight. */
  loading?: boolean;
  /** Extra controls pinned to the far right of the band (e.g. Refresh). */
  actions?: React.ReactNode;
  className?: string;
};

/** One square icon button in the pager. Internal to the filter band. */
function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40",
        ADMIN_FOCUS_RING_BAND,
      )}
    >
      {children}
    </button>
  );
}

/** The filter band: controls on the left, result range and pager on the right. */
export default function AdminFilterBar({
  children,
  page,
  pageSize,
  total,
  onPageChange,
  noun,
  loading = false,
  actions,
  className,
}: AdminFilterBarProps) {
  const paged =
    typeof page === "number" && typeof pageSize === "number" && typeof total === "number" && pageSize > 0;
  const totalPages = paged ? Math.max(1, Math.ceil((total || 0) / (pageSize as number))) : 1;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2",
        className,
      )}
    >
      {children}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {paged ? (
          <span className="text-[12px] leading-5 tabular-nums text-[var(--muted-2)]">
            {rangeLabel(page as number, pageSize as number, total as number)}
            {noun ? ` ${noun}` : ""}
          </span>
        ) : null}
        {paged && onPageChange ? (
          <div className="flex items-center gap-1">
            <PagerButton
              label="Previous page"
              disabled={loading || (page as number) <= 1}
              onClick={() => onPageChange(Math.max(1, (page as number) - 1))}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </PagerButton>
            <PagerButton
              label="Next page"
              disabled={loading || (page as number) >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, (page as number) + 1))}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </PagerButton>
          </div>
        ) : null}
        {actions}
      </div>
    </div>
  );
}
