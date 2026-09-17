/**
 * Page-by-page table: how many people reached each page, typical time among those who stayed, how
 * many skipped it, and where people left. A table from 640px; below that one row per page with each
 * figure labelled inline. Column headers sort. Bold marks exactly the pages the callouts name.
 */
"use client";

import { useState } from "react";
import { formatDwell } from "@/lib/analytics/reading/format";
import type { Callouts, PageRow } from "@/lib/analytics/reading/types";
import { InfoTip, tileLabelClass } from "./KpiStrip";
import { LEFT_TOOLTIP, REACHED_TOOLTIP, SKIPPED_TOOLTIP, TYPICAL_TOOLTIP } from "./ReadingMatrix";
import { emphasisPages, skippedBreakdown, typicalDisplay, type TypicalDisplay } from "./pageEmphasis";

export type PagePerformanceTableProps = {
  pages: PageRow[];
  pageCount: number;
  peopleWithDetail: number;
  callouts: Callouts | null;
};

type SortKey = "reached" | "typical" | "skipped" | "left";

const DESKTOP_GRID = "grid-cols-[32px_minmax(0,2fr)_repeat(4,minmax(0,1fr))] items-center gap-x-3";

function skippedOf(row: PageRow): number {
  return row.passed + row.jumped;
}

function sortValue(row: PageRow, key: SortKey): number {
  if (key === "reached") return row.reached;
  if (key === "typical") return row.typicalMs ?? -1;
  if (key === "skipped") return skippedOf(row);
  return row.leftHere;
}

function Bar({ value, max, muted = false }: { value: number; max: number; muted?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <span aria-hidden="true" className="block h-1 w-full max-w-[64px] overflow-hidden rounded-full bg-[var(--panel-hover)]">
      <span
        className={`block h-full rounded-full ${muted ? "bg-[var(--muted-2)] opacity-60" : "bg-emerald-500"}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

const sortButtonClass =
  "rounded text-left hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

function HeaderCell({
  label,
  tip,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  tip: string;
  sortKey: SortKey;
  sort: SortKey | null;
  onSort: (key: SortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <div className={`${tileLabelClass} flex min-w-0 flex-wrap items-center gap-x-1`} aria-sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={active ? "Back to page order" : "Sort, highest first"}
        className={`${sortButtonClass} uppercase tracking-wide ${active ? "text-[var(--fg)]" : ""}`}
      >
        {label}
        {active ? <span aria-hidden="true"> ↓</span> : null}
      </button>
      <InfoTip text={tip} />
    </div>
  );
}

function Thumb({ row, className }: { row: PageRow; className: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] text-[11px] font-semibold text-[var(--muted)] ${className}`}
    >
      {row.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={row.thumbUrl} alt="" loading="lazy" className="h-full w-full object-contain" />
      ) : (
        row.page
      )}
    </span>
  );
}

const MOBILE_TIPS: Array<[string, string]> = [
  ["Reached", REACHED_TOOLTIP],
  ["Typical", TYPICAL_TOOLTIP],
  ["Skipped", SKIPPED_TOOLTIP],
  ["Left", LEFT_TOOLTIP],
];

const subClass = "block truncate text-[11px] leading-4 text-[var(--muted)]";

/** The typical-time value by the shared stayer rule: ranked may be bold, thin is muted with its count, few is a dash. */
function TypicalValue({ t, strong }: { t: TypicalDisplay; strong: boolean }) {
  if (t.kind === "ranked") return <span className={strong ? "font-semibold text-[var(--fg)]" : "text-[var(--fg)]"}>{formatDwell(t.ms)}</span>;
  if (t.kind === "thin") {
    return (
      <span className="text-[var(--muted)]" title={t.title}>
        {`${formatDwell(t.ms)} (${t.readCount})`}
      </span>
    );
  }
  return <span className="text-[var(--muted)]">—</span>;
}

/** Per-page performance table. */
export default function PagePerformanceTable({ pages, pageCount, peopleWithDetail, callouts }: PagePerformanceTableProps) {
  const [sort, setSort] = useState<SortKey | null>(null);
  const [tipsOpen, setTipsOpen] = useState(false);

  const bold = emphasisPages(callouts, pageCount, pages);
  let maxTypical = 0;
  for (const r of pages) maxTypical = Math.max(maxTypical, r.typicalMs ?? 0);

  const ordered = sort ? [...pages].sort((a, b) => sortValue(b, sort) - sortValue(a, sort) || a.page - b.page) : pages;
  const onSort = (key: SortKey) => setSort((cur) => (cur === key ? null : key));
  const strong = (on: boolean) => (on ? "font-semibold text-[var(--fg)]" : "text-[var(--fg)]");

  return (
    <div data-page-table>
      <div className={`hidden border-b border-[var(--border)] pb-2 sm:grid ${DESKTOP_GRID}`}>
        <div className={`col-span-2 ${tileLabelClass}`}>
          {sort ? (
            <button type="button" onClick={() => setSort(null)} className={`${sortButtonClass} uppercase tracking-wide`}>
              Page
            </button>
          ) : (
            "Page"
          )}
        </div>
        <HeaderCell label={`Reached (of ${peopleWithDetail})`} tip={REACHED_TOOLTIP} sortKey="reached" sort={sort} onSort={onSort} />
        <HeaderCell label="Typical time" tip={TYPICAL_TOOLTIP} sortKey="typical" sort={sort} onSort={onSort} />
        <HeaderCell label="Skipped" tip={SKIPPED_TOOLTIP} sortKey="skipped" sort={sort} onSort={onSort} />
        <HeaderCell label="Left here" tip={LEFT_TOOLTIP} sortKey="left" sort={sort} onSort={onSort} />
      </div>

      <div data-pages-mobile-head className="border-b border-[var(--border)] pb-1.5 sm:hidden">
        <button
          type="button"
          aria-expanded={tipsOpen}
          onClick={() => setTipsOpen((v) => !v)}
          className="inline-flex h-11 items-center gap-1 text-[12px] font-medium text-[var(--muted)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {`${peopleWithDetail} ${peopleWithDetail === 1 ? "person" : "people"} with page detail · what these mean`}
          <span aria-hidden="true">{tipsOpen ? "▴" : "▾"}</span>
        </button>
        {tipsOpen ? (
          <dl className="grid gap-1 pb-1 text-[11px] text-[var(--muted)]">
            {MOBILE_TIPS.map(([term, text]) => (
              <div key={term}>
                <dt className="inline font-semibold text-[var(--fg)]">{`${term}: `}</dt>
                <dd className="inline">{text}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      <div className="divide-y divide-[var(--border)]">
        {ordered.map((row) => {
          const skipped = skippedOf(row);
          const detail = skippedBreakdown(row.passed, row.jumped);
          const t = typicalDisplay(row);
          const isLast = row.page === pageCount;
          const typicalBold = t.kind === "ranked" && bold.typical.has(row.page);
          const skippedBold = skipped > 0 && bold.skipped.has(row.page);
          const leftBold = row.leftHere > 0 && bold.left.has(row.page);
          return (
            <div
              key={row.page}
              id={`page-row-${row.page}`}
              data-page-row
              className="scroll-mt-24 rounded-lg px-1 transition-colors duration-500"
            >
              <div className={`hidden min-h-[52px] py-1.5 sm:grid ${DESKTOP_GRID}`}>
                <Thumb row={row} className="h-6 w-8 text-[10px]" />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">{`Page ${row.page}`}</div>
                  {row.label ? (
                    <div className="truncate text-[12px] leading-4 text-[var(--muted)]" title={row.label}>
                      {row.label}
                    </div>
                  ) : null}
                </div>
                <div data-col="reached" className="flex min-w-0 items-center gap-2 text-[13px] leading-5 tabular-nums text-[var(--fg)]">
                  {row.reached}
                  <Bar value={row.reached} max={peopleWithDetail} />
                </div>
                <div data-col="typical" className="min-w-0 text-[13px] leading-5 tabular-nums">
                  <span className="flex items-center gap-2">
                    <TypicalValue t={t} strong={typicalBold} />
                    {t.kind === "ranked" ? <Bar value={t.ms} max={maxTypical} /> : null}
                  </span>
                  {t.kind === "ranked" ? <span className={subClass}>{`${t.readCount} stayed on it`}</span> : null}
                  {t.kind === "few" ? <span className={subClass}>{t.text}</span> : null}
                </div>
                <div data-col="skipped" className="min-w-0 text-[13px] leading-5 tabular-nums" title={SKIPPED_TOOLTIP}>
                  {skipped > 0 ? <span className={strong(skippedBold)}>{skipped}</span> : <span className="text-[var(--muted)]">—</span>}
                  {detail ? <span className={subClass}>{detail}</span> : null}
                </div>
                <div data-col="left" className="min-w-0 text-[13px] leading-5 tabular-nums">
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap">
                      {row.leftHere > 0 ? <span className={strong(leftBold)}>{row.leftHere}</span> : <span className="text-[var(--muted)]">—</span>}
                      {isLast ? <span className="text-[var(--muted)]"> · last page</span> : null}
                    </span>
                    {row.leftHere > 0 ? <Bar value={row.leftHere} max={peopleWithDetail} muted /> : null}
                  </span>
                </div>
              </div>

              <div data-page-row-mobile className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2.5 py-2 text-[12px] tabular-nums sm:hidden">
                <Thumb row={row} className="mt-0.5 h-6 w-8 text-[10px]" />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">{`Page ${row.page}`}</div>
                  {row.label ? (
                    <div className="line-clamp-2 text-[12px] leading-4 text-[var(--muted)]" title={row.label}>
                      {row.label}
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 leading-5">
                    <span>
                      <span className="text-[var(--muted)]">Reached </span>
                      <span className="text-[var(--fg)]">{row.reached}</span>
                    </span>
                    <span>
                      <span className="text-[var(--muted)]">Typical </span>
                      <TypicalValue t={t} strong={typicalBold} />
                      {t.kind === "few" ? <span className="text-[var(--muted)]">{` (${t.text})`}</span> : null}
                    </span>
                    <span title={detail ?? undefined}>
                      <span className="text-[var(--muted)]">Skipped </span>
                      {skipped > 0 ? <span className={strong(skippedBold)}>{skipped}</span> : <span className="text-[var(--muted)]">—</span>}
                    </span>
                    <span>
                      <span className="text-[var(--muted)]">Left </span>
                      {row.leftHere > 0 ? <span className={strong(leftBold)}>{row.leftHere}</span> : <span className="text-[var(--muted)]">—</span>}
                      {isLast ? <span className="text-[var(--muted)]"> · last page</span> : null}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
