/**
 * Page-by-page table: how many people reached each page, typical time among those who stayed,
 * how many passed it over, and where people left. One DOM for both layouts: a table from 640px,
 * a labelled card per page below.
 */
"use client";

import { formatCountOf, formatDwell } from "@/lib/analytics/reading/format";
import type { PageRow } from "@/lib/analytics/reading/types";
import { InfoTip, tileLabelClass } from "./KpiStrip";
import { REACHED_TOOLTIP, TYPICAL_TOOLTIP } from "./ReadingMatrix";

const PASSED_TOOLTIP = "People who had this page on screen for under 2 seconds.";
const LEFT_TOOLTIP = "People whose most recent time in the document ended on this page.";

export type PagePerformanceTableProps = {
  pages: PageRow[];
  pageCount: number;
  peopleWithDetail: number;
};

const ROW_GRID =
  "grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[40px_minmax(0,2fr)_repeat(4,minmax(0,1fr))] sm:items-center";

function MobileLabel({ label, tip }: { label: string; tip: string }) {
  return (
    <span className={`block sm:hidden ${tileLabelClass}`}>
      {label} <InfoTip text={tip} />
    </span>
  );
}

function HeaderCell({ label, tip }: { label: string; tip: string }) {
  return (
    <div className={tileLabelClass} title={tip}>
      {label} <InfoTip text={tip} />
    </div>
  );
}

/** Per-page performance table. */
export default function PagePerformanceTable({ pages, pageCount, peopleWithDetail }: PagePerformanceTableProps) {
  return (
    <div id="pages" className="scroll-mt-20">
      <div className={`hidden border-b border-[var(--border)] pb-2 sm:grid ${ROW_GRID.replace("grid ", "")}`}>
        <div className={`col-span-2 ${tileLabelClass}`}>Page</div>
        <HeaderCell label="Reached" tip={REACHED_TOOLTIP} />
        <HeaderCell label="Typical time" tip={TYPICAL_TOOLTIP} />
        <HeaderCell label="Passed" tip={PASSED_TOOLTIP} />
        <HeaderCell label="Left here" tip={LEFT_TOOLTIP} />
      </div>
      <div className="divide-y divide-[var(--border)]">
        {pages.map((row) => (
          <div
            key={row.page}
            id={`page-row-${row.page}`}
            data-page-row
            className={`${ROW_GRID} scroll-mt-24 rounded-lg px-1 py-3 transition-colors duration-500`}
          >
            <span className="row-span-2 flex h-[42px] w-14 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted)] sm:row-span-1 sm:h-[30px] sm:w-10">
              {row.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
              ) : (
                row.page
              )}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--fg)]">{`Page ${row.page}`}</div>
              {row.label ? <div className="truncate text-[12px] text-[var(--muted)]">{row.label}</div> : null}
            </div>
            <div className="col-start-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:contents">
              <div className="min-w-0 text-[13px] tabular-nums text-[var(--fg)]">
                <MobileLabel label="Reached" tip={REACHED_TOOLTIP} />
                {formatCountOf(row.reached, peopleWithDetail)}
              </div>
              <div className="min-w-0 text-[13px] tabular-nums text-[var(--fg)]">
                <MobileLabel label="Typical time" tip={TYPICAL_TOOLTIP} />
                {row.typicalMs === null ? "—" : formatDwell(row.typicalMs)}
                {row.readCount > 0 ? (
                  <span className="block text-[11px] text-[var(--muted)]">{`${row.readCount} stayed on it`}</span>
                ) : null}
              </div>
              <div className="min-w-0 text-[13px] tabular-nums text-[var(--fg)]">
                <MobileLabel label="Passed" tip={PASSED_TOOLTIP} />
                {row.passed > 0 ? row.passed : "—"}
              </div>
              <div className="min-w-0 text-[13px] tabular-nums text-[var(--fg)]">
                <MobileLabel label="Left here" tip={LEFT_TOOLTIP} />
                {row.leftHere > 0 ? row.leftHere : "—"}
                {row.page === pageCount ? <span className="text-[var(--muted)]"> · last page</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
