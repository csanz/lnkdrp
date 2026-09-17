/**
 * ReadingMatrix: one row per person, one column per page. Shade is time on the page; hatched is
 * passed over, a bar marks where their latest time in the document ended, ↺ marks a return.
 */
"use client";

import { useState } from "react";
import { hotReasonText } from "@/lib/analytics/reading/attention";
import { formatDwell, formatDwellCompact, formatRelative } from "@/lib/analytics/reading/format";
import type { MatrixRow, PageRow } from "@/lib/analytics/reading/types";
import { MATRIX_ALL_LIMIT } from "@/lib/analytics/reading/constants";
import { cellOpacity } from "./matrixScale";

const EMERALD = "rgb(16 185 129)";
const PASSED_BG = "repeating-linear-gradient(45deg, rgb(16 185 129 / .35) 0 2px, transparent 2px 5px)";

export const REACHED_TOOLTIP = "People who had this page on screen.";
export const TYPICAL_TOOLTIP =
  "Median time among people who stayed on this page for 2 seconds or more. Shown once 3 people have.";

export type ReadingMatrixProps = {
  rows: MatrixRow[];
  total: number;
  limit: number;
  pages: PageRow[];
  pageCount: number;
  peopleWithDetail: number;
  now: number;
  onOpenPerson: (row: MatrixRow) => void;
  onShowAll: () => void;
  loadingAll: boolean;
};

function cellDescription(row: MatrixRow, p: number): string {
  const cell = row.cells[p - 1];
  if (!cell) return `${row.name}, page ${p}: not reached`;
  let what: string;
  if (cell.state === "read") what = formatDwell(cell.ms);
  else if (cell.state === "passed") what = "passed";
  else if (cell.state === "unknown") what = "time not recorded";
  else what = "not reached";
  return `${row.name}, page ${p}: ${what}${cell.revisit ? ", went back" : ""}${row.exitPage === p ? ", left here" : ""}`;
}

function pageTitle(p: number, pages: PageRow[]): string {
  const label = pages[p - 1]?.label;
  return `Page ${p}${label ? ` · ${label}` : ""}`;
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {swatch}
      {label}
    </span>
  );
}

const swatchClass = "inline-block h-3 w-3 rounded-[3px]";

/** Person × page matrix with footer rows and legend. */
export default function ReadingMatrix({
  rows,
  total,
  limit,
  pages,
  pageCount,
  now,
  onOpenPerson,
  onShowAll,
  loadingAll,
}: ReadingMatrixProps) {
  const [caption, setCaption] = useState("");
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
  let maxMs = 0;
  for (const row of rows) for (const c of row.cells) if (c.state === "read" && c.ms > maxMs) maxMs = c.ms;
  const showThumbs = pageCount <= 30;
  const gridStyle = { gridTemplateColumns: `var(--mx-first) repeat(${pageCount}, var(--mx-col))` };
  const firstCell = "sticky left-0 z-[1] bg-[var(--panel-2)] pr-2";

  return (
    <div>
      <div data-matrix className="overflow-x-auto">
        <div
          className="grid items-center gap-x-[3px] gap-y-1 [--mx-col:28px] [--mx-first:132px] sm:[--mx-col:minmax(28px,56px)] sm:[--mx-first:208px]"
          style={gridStyle}
        >
          <div className="contents">
            <div className={`${firstCell} self-end text-[11px] font-semibold text-[var(--muted-2)]`}>
              <span className="sr-only">Person</span>
            </div>
            {pageNumbers.map((p) => {
              const meta = pages[p - 1];
              return (
                <div
                  key={p}
                  title={pageTitle(p, pages)}
                  className="flex flex-col items-center gap-1 self-end text-[11px] font-medium tabular-nums text-[var(--muted)]"
                >
                  {showThumbs ? (
                    <span className="hidden h-[21px] w-7 overflow-hidden rounded-[3px] border border-[var(--border)] bg-[var(--panel)] sm:block">
                      {meta?.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={meta.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : null}
                    </span>
                  ) : null}
                  {p}
                </div>
              );
            })}
          </div>

          {rows.map((row) => (
            <div key={row.personId} className="contents">
              <div className={firstCell}>
                <button
                  type="button"
                  data-matrix-row
                  onClick={() => onOpenPerson(row)}
                  className="block w-full min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-[var(--fg)]">{row.name}</span>
                    {row.activeNow ? (
                      <span
                        aria-label="Active in the last 10 minutes"
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: EMERALD }}
                      />
                    ) : null}
                    {row.hot ? (
                      <span
                        title={hotReasonText(row.hot)}
                        className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-semibold leading-4 text-emerald-700 dark:text-emerald-300"
                      >
                        Hot
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--muted)]">
                    {row.linkLabel} · {formatRelative(row.lastSeen, now)}
                  </span>
                </button>
              </div>
              {pageNumbers.map((p) => {
                const cell = row.cells[p - 1];
                const state = cell?.state ?? "unreached";
                const label = cellDescription(row, p);
                let fill: React.ReactNode = null;
                let cls = "";
                if (state === "read") {
                  fill = (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 rounded-[4px]"
                      style={{ backgroundColor: EMERALD, opacity: cellOpacity(cell?.ms ?? 0, maxMs) }}
                    />
                  );
                } else if (state === "passed") {
                  fill = <span aria-hidden="true" className="absolute inset-0 rounded-[4px]" style={{ background: PASSED_BG }} />;
                } else if (state === "unknown") {
                  cls = "border border-dotted border-[var(--muted-2)]";
                } else {
                  // The fill alone nearly matches the card in dark mode; the border keeps the cell visible.
                  cls = "border border-[var(--border)]";
                  fill = <span aria-hidden="true" className="absolute inset-0 rounded-[3px] bg-[var(--panel-hover)] opacity-60" />;
                }
                return (
                  <button
                    key={p}
                    type="button"
                    aria-label={label}
                    onMouseEnter={() => setCaption(label)}
                    onFocus={() => setCaption(label)}
                    onClick={() => setCaption(label)}
                    className={`relative h-7 w-full rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${cls}`}
                  >
                    {fill}
                    {row.exitPage === p ? (
                      <span aria-hidden="true" className="absolute inset-y-0 right-0 w-[3px] rounded-r-[4px] bg-[var(--fg)] opacity-70" />
                    ) : null}
                    {cell?.revisit ? (
                      <span aria-hidden="true" className="absolute right-[4px] top-[1px] text-[9px] leading-none text-[var(--fg)]">
                        ↺
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}

          <div className="contents">
            <div className={`${firstCell} border-t border-[var(--border)] pt-2 text-[11px] font-semibold text-[var(--muted)]`}>
              <span title={TYPICAL_TOOLTIP}>Typical time</span>
            </div>
            {pageNumbers.map((p) => (
              <div
                key={p}
                className="border-t border-[var(--border)] pt-2 text-center text-[11px] tabular-nums text-[var(--muted)]"
              >
                {formatDwellCompact(pages[p - 1]?.typicalMs ?? null)}
              </div>
            ))}
          </div>
          <div className="contents">
            <div className={`${firstCell} text-[11px] font-semibold text-[var(--muted)]`}>
              <span title={REACHED_TOOLTIP}>Reached</span>
            </div>
            {pageNumbers.map((p) => (
              <div key={p} className="text-center text-[11px] tabular-nums text-[var(--muted)]" title={REACHED_TOOLTIP}>
                {pages[p - 1]?.reached ?? 0}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-2 min-h-[18px] text-[12px] text-[var(--muted)]" aria-live="polite">
        {caption}
      </p>

      {total > rows.length && limit < MATRIX_ALL_LIMIT ? (
        <button
          type="button"
          onClick={onShowAll}
          disabled={loadingAll}
          className="mt-2 inline-flex h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
        >
          {loadingAll
            ? "Loading…"
            : total > MATRIX_ALL_LIMIT
              ? `Show the ${MATRIX_ALL_LIMIT} most recent people`
              : `Show all ${total} people`}
        </button>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-[var(--muted)]" data-matrix-legend>
        <LegendItem
          label="Darker = more time (2s or more)"
          swatch={
            <span className="inline-flex gap-[2px]" aria-hidden="true">
              <span className={swatchClass} style={{ backgroundColor: EMERALD, opacity: 0.3 }} />
              <span className={swatchClass} style={{ backgroundColor: EMERALD }} />
            </span>
          }
        />
        <LegendItem label="Passed (under 2s)" swatch={<span aria-hidden="true" className={swatchClass} style={{ background: PASSED_BG }} />} />
        <LegendItem
          label="Time not recorded"
          swatch={<span aria-hidden="true" className={`${swatchClass} border border-dotted border-[var(--muted-2)]`} />}
        />
        <LegendItem
          label="Not reached"
          swatch={
            <span aria-hidden="true" className={`${swatchClass} relative border border-[var(--border)]`}>
              <span className="absolute inset-0 rounded-[2px] bg-[var(--panel-hover)] opacity-60" />
            </span>
          }
        />
        <LegendItem label="▎ Left here" swatch={null} />
        <LegendItem label="↺ Went back" swatch={null} />
      </div>
    </div>
  );
}
