/**
 * ReadingMatrix: one row per person, one column per page, then each person's total time. Shade is
 * time on the page in fixed steps; hatches mark pages on screen under 2s or jumped past; a bar marks
 * where their latest time in the document ended; ↺ marks a return. Hovering or focusing a cell or
 * page number shows a popover; clicking a cell opens that person at that page. On touch screens the
 * first tap on a cell shows the popover (with Open) and a second tap opens the person.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { hotReasonText } from "@/lib/analytics/reading/attention";
import { MATRIX_ALL_LIMIT } from "@/lib/analytics/reading/constants";
import { formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { Callouts, CellState, HotReason, MatrixRow, PageRow } from "@/lib/analytics/reading/types";
import { InfoTip } from "./KpiStrip";
import { CELL_STEP_LABELS, MATRIX_RAMP_CSS, cellStep, formatCellDwell } from "./matrixScale";
import { emphasisPages, pageHeadline, pageShortLabel, shortLinkLabel, skippedBreakdown, typicalDisplay } from "./pageEmphasis";

const PASSED_BG = "repeating-linear-gradient(45deg, rgb(16 185 129 / .45) 0 2px, transparent 2px 5px)";
const JUMPED_BG = "repeating-linear-gradient(-45deg, var(--muted-2) 0 1px, transparent 1px 5px)";
/** Rendered column width from which a stayed cell also prints its time. */
const CELL_TEXT_MIN_PX = 44;
/** Up to this many pages the columns stretch to fill the card instead of scrolling. */
const FILL_MAX_PAGES = 8;
const TOUCH_QUERY = "(hover: none)";
const NARROW_QUERY = "(max-width: 639px)";

export const REACHED_TOOLTIP = "People who had this page on screen.";
export const TYPICAL_TOOLTIP =
  "Median time among people who stayed on this page for 2 seconds or more. Shown once 3 people have; greyed until 5 have.";
export const SKIPPED_TOOLTIP = "People who jumped past this page or had it on screen for under 2 seconds.";
export const LEFT_TOOLTIP = "People whose most recent time in the document ended on this page.";

export type ReadingMatrixProps = {
  rows: MatrixRow[];
  total: number;
  limit: number;
  pages: PageRow[];
  pageCount: number;
  peopleWithDetail: number;
  callouts: Callouts | null;
  /** Set when the page is filtered to one link, so rows don't repeat its label. */
  shareId: string | null;
  now: number;
  /** `page` is set when a cell was clicked, so the reader can open at that page. */
  onOpenPerson: (row: MatrixRow, page?: number) => void;
  onShowAll: () => void;
  loadingAll: boolean;
};

function cellKind(row: MatrixRow, p: number): CellState {
  return row.cells[p - 1]?.state ?? "unreached";
}

function isAnonymous(row: MatrixRow): boolean {
  return row.source === "anonymous" && row.anonNumber !== null;
}

/** The name as the row shows it: phones shorten anonymous people to "Reader 14". */
function displayName(row: MatrixRow, narrow: boolean): string {
  return narrow && isAnonymous(row) ? `Reader ${row.anonNumber}` : row.name;
}

function cellText(row: MatrixRow, p: number, pages: PageRow[], narrow = false): string {
  const cell = row.cells[p - 1];
  const kind = cellKind(row, p);
  let what: string;
  if (kind === "read") {
    const typical = typicalDisplay(pages[p - 1]);
    what = `${formatDwell(cell?.ms ?? 0)}${typical.kind === "ranked" ? ` · typical ${formatDwell(typical.ms)}` : ""}`;
  } else if (kind === "passed") what = "<2s";
  else if (kind === "jumped") what = "jumped past";
  else if (kind === "unknown") what = "time not recorded";
  else what = "not reached";
  return `${displayName(row, narrow)} · ${pageHeadline(p, pages[p - 1])} · ${what}${cell?.revisit ? " · went back" : ""}${
    row.exitPage === p ? " · left here" : ""
  }`;
}

function hotPillText(r: HotReason, withTotal = true): string {
  if (r.kind === "returned") return "Came back";
  if (r.kind === "read_most") {
    const base = r.read >= r.pageCount ? "Stayed on all" : `Stayed on ${r.read}/${r.pageCount}`;
    return withTotal && Number.isFinite(r.totalMs) ? `${base} · ${formatDwell(r.totalMs)}` : base;
  }
  return `${formatDwell(r.ms)} on page ${r.page}`;
}

const swatchClass = "inline-block h-3 w-3 shrink-0 rounded-[3px]";

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {swatch}
      {label}
    </span>
  );
}

function RampStyle() {
  return (
    <style href="lnkdrp-matrix-ramp" precedence="default">
      {MATRIX_RAMP_CSS}
    </style>
  );
}

/** Legend for the matrix, placed directly above it. */
export function MatrixLegend() {
  return (
    <div data-matrix-legend data-mx-ramp className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-[var(--muted)]">
      <RampStyle />
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        Time on page
        <span className="inline-flex gap-[2px]" aria-hidden="true">
          {CELL_STEP_LABELS.map((label, i) => (
            <span key={label} className="flex w-6 flex-col items-center gap-0.5">
              <span className="block h-3 w-6 rounded-[3px]" style={{ backgroundColor: `var(--mx-${i + 1})` }} />
              <span className="text-[9px] leading-none tabular-nums">{label}</span>
            </span>
          ))}
        </span>
        <span className="sr-only">from 2 seconds to 1 minute or more, darker steps for longer</span>
      </span>
      <LegendItem label="Under 2s" swatch={<span aria-hidden="true" className={swatchClass} style={{ background: PASSED_BG }} />} />
      <LegendItem
        label="Jumped past"
        swatch={<span aria-hidden="true" className={`${swatchClass} border border-[var(--border)]`} style={{ background: JUMPED_BG }} />}
      />
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
      <LegendItem label="Active now" swatch={<span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />} />
      <LegendItem label="↺ Went back" swatch={null} />
    </div>
  );
}

/** `pinned`: opened by a tap on a touch screen; it stays until a tap elsewhere and takes pointer events. */
type Tip = { key: string; anchor: HTMLElement; content: React.ReactNode; pinned?: boolean };
type View = { overflow: boolean; atEnd: boolean; first: number; last: number };

const stickyBg = "bg-[var(--panel-2)]";
// The shadows paint over the 3px column gap and 4px row gap so scrolled cells never show through.
const headShadow = "shadow-[3px_4px_0_var(--panel-2)]";
const nameShadow = "shadow-[3px_0_0_var(--panel-2)]";

/** Person × page matrix with footer rows. */
export default function ReadingMatrix({
  rows,
  total,
  limit,
  pages,
  pageCount,
  callouts,
  shareId,
  now,
  onOpenPerson,
  onShowAll,
  loadingAll,
}: ReadingMatrixProps) {
  const [caption, setCaption] = useState("");
  const [tip, setTip] = useState<Tip | null>(null);
  const [colW, setColW] = useState(0);
  const [barH, setBarH] = useState(0);
  const [view, setView] = useState<View>({ overflow: false, atEnd: true, first: 1, last: pageCount });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);

  // The phone page-number strip sticks just under the sticky control bar, whose height varies.
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>("[data-control-bar]");
    if (!bar) return;
    const update = () => setBarH(Math.round(bar.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    const root = rootRef.current;
    if (!scroller || !root) return;
    const visible = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getBoundingClientRect().width > 0);
    const measure = () => {
      const strip = stripRef.current;
      if (strip && strip.scrollLeft !== scroller.scrollLeft) strip.scrollLeft = scroller.scrollLeft;
      const cell = scroller.querySelector<HTMLElement>("[data-matrix-cell]");
      if (cell) setColW(Math.floor(cell.getBoundingClientRect().width));
      const box = scroller.getBoundingClientRect();
      const nameRight = box.left + (visible("[data-name-head]")[0]?.getBoundingClientRect().width ?? 0);
      let first = 0;
      let last = 0;
      for (const el of visible("[data-page-head]")) {
        const r = el.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        const p = Number(el.dataset.pageHead);
        if (mid > nameRight && mid < box.right) {
          if (!first) first = p;
          last = p;
        }
      }
      const next: View = {
        overflow: scroller.scrollWidth > scroller.clientWidth + 1,
        atEnd: scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2,
        first: first || 1,
        last: last || pageCount,
      };
      setView((prev) =>
        prev.overflow === next.overflow && prev.atEnd === next.atEnd && prev.first === next.first && prev.last === next.last ? prev : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    if (gridRef.current) ro.observe(gridRef.current);
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, [pageCount]);

  // A hover tip goes above its anchor; a tapped one goes below so it doesn't cover the row above.
  // Either flips when there is no room, and is clamped to the viewport.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    const a = tip.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8));
    let top: number;
    if (tip.pinned) {
      top = a.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    } else {
      top = a.top - h - 6;
      if (top < 8) top = Math.min(a.bottom + 6, window.innerHeight - h - 8);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "visible";
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (tipRef.current?.contains(target) || tip.anchor.contains(target))) return;
      setTip(null);
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    if (tip.pinned) document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [tip]);

  // Hover and focus leaving never close a tapped popover; its Open button would blur the cell first.
  const hideTip = () => setTip((t) => (t?.pinned ? t : null));
  const showCellTip = (anchor: HTMLElement, row: MatrixRow, p: number, pinned = false) => {
    const text = cellText(row, p, pages, window.matchMedia(NARROW_QUERY).matches);
    setCaption(text);
    setTip({
      key: `c:${row.personId}:${p}`,
      anchor,
      pinned,
      content: pinned ? (
        <span className="flex max-w-[300px] items-center gap-3">
          <span className="min-w-0 text-[12px] text-[var(--fg)]">{text}</span>
          <button
            type="button"
            data-matrix-popover-open
            onClick={() => {
              setTip(null);
              onOpenPerson(row, p);
            }}
            className="inline-flex h-11 shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] sm:h-9 sm:px-2.5"
          >
            Open →
          </button>
        </span>
      ) : (
        <span className="block max-w-[260px] text-[12px] text-[var(--fg)]">{text}</span>
      ),
    });
  };
  const onCellClick = (anchor: HTMLElement, row: MatrixRow, p: number) => {
    if (!window.matchMedia(TOUCH_QUERY).matches) {
      onOpenPerson(row, p);
      return;
    }
    if (tip?.pinned && tip.key === `c:${row.personId}:${p}`) {
      setTip(null);
      onOpenPerson(row, p);
      return;
    }
    showCellTip(anchor, row, p, true);
  };
  const showPageTip = (anchor: HTMLElement, p: number) => {
    const meta = pages[p - 1];
    const t = typicalDisplay(meta);
    const typical =
      t.kind === "ranked"
        ? `typical ${formatDwell(t.ms)}`
        : t.kind === "thin"
          ? `typical ${formatDwell(t.ms)} (${t.readCount} stayed)`
          : t.kind === "few"
            ? t.text
            : "typical —";
    setTip({
      key: `p:${p}`,
      anchor,
      content: (
        <span className="block w-[160px]">
          <span className="flex h-[120px] w-[160px] items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] text-[13px] font-semibold text-[var(--muted)]">
            {meta?.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.thumbUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              p
            )}
          </span>
          <span className="mt-1.5 block text-[12px] font-semibold text-[var(--fg)]">{pageHeadline(p, meta)}</span>
          <span className="block text-[11px] text-[var(--muted)]">{`reached ${meta?.reached ?? 0} · ${typical}`}</span>
        </span>
      ),
    });
  };

  const bold = emphasisPages(callouts, pageCount, pages);
  const footerValue = (value: number, strong: boolean, title?: string) => (
    <span title={title} className={value > 0 && strong ? "font-semibold text-[var(--fg)]" : "text-[var(--muted)]"}>
      {value > 0 ? value : "—"}
    </span>
  );

  const showCellText = colW >= CELL_TEXT_MIN_PX;
  const gridStyle = { gridTemplateColumns: `var(--mx-first) repeat(${pageCount}, var(--mx-col)) var(--mx-time)` };
  // A short document gives up a little of the name column on phones so the Time column fits too.
  const colVars =
    pageCount <= FILL_MAX_PAGES
      ? "[--mx-col:minmax(28px,1fr)] [--mx-first:minmax(116px,132px)]"
      : "[--mx-col:28px] [--mx-first:132px] sm:[--mx-col:minmax(28px,96px)]";
  // w-fit: the grid box is as wide as its tracks once they overflow (so the sticky name column can
  // travel the whole swipe) but still shrinks tracks to fit when they can.
  const gridClass = `grid w-fit min-w-full items-center gap-x-[3px] gap-y-1 ${colVars} [--mx-time:44px] sm:[--mx-first:minmax(208px,280px)] sm:[--mx-time:72px] lg:[--mx-first:minmax(260px,280px)]`;
  let hintSuffix = "";
  if (!view.atEnd) hintSuffix = view.last < pageCount ? " · swipe for more" : " · swipe for total time";
  const nameCell = `sticky left-0 z-[1] self-stretch ${stickyBg} ${nameShadow} pr-2`;
  const footLabel = `${nameCell} flex flex-wrap items-center gap-x-1 text-[11px] font-semibold text-[var(--muted)]`;
  const footCell = "relative self-stretch text-center text-[11px] leading-tight tabular-nums";
  const mask = view.overflow && !view.atEnd ? "linear-gradient(to right, #000 calc(100% - 16px), transparent)" : undefined;

  // On phones the repeated page-number row above the footer already draws the divider.
  const firstFoot = "sm:border-t sm:border-[var(--border)] sm:pt-2";
  const footerRow = (label: string, tipText: string, cell: (p: number) => React.ReactNode, first = false) => (
    <div className="contents">
      <div className={`${footLabel} ${first ? firstFoot : ""}`}>
        <span>{label}</span>
        <InfoTip text={tipText} />
      </div>
      {pageNumbers.map((p) => (
        <div key={p} className={`${footCell} ${first ? firstFoot : ""}`}>
          {cell(p)}
        </div>
      ))}
      <div className={first ? "sm:border-t sm:border-[var(--border)]" : ""} />
    </div>
  );

  const pageHeadButton = (p: number) => (
    <button
      type="button"
      aria-label={`Page ${p}${pageShortLabel(pages[p - 1]) ? `, ${pageShortLabel(pages[p - 1])}` : ""}`}
      onMouseEnter={(e) => showPageTip(e.currentTarget, p)}
      onMouseLeave={hideTip}
      onFocus={(e) => showPageTip(e.currentTarget, p)}
      onBlur={hideTip}
      onClick={(e) => showPageTip(e.currentTarget, p)}
      className="h-6 w-full rounded-[4px] text-[11px] font-medium tabular-nums text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      {p}
    </button>
  );

  return (
    <div ref={rootRef} data-mx-ramp onKeyDown={(e) => (e.key === "Escape" && tip ? setTip(null) : undefined)}>
      <RampStyle />
      <div data-matrix-strip className={`sticky z-[4] ${stickyBg} pb-1 sm:hidden`} style={{ top: barH }}>
        {view.overflow ? (
          <p data-matrix-hint className="pb-1 text-[12px] text-[var(--muted)]">
            {`Pages ${view.first}–${view.last} of ${pageCount}${hintSuffix}`}
          </p>
        ) : null}
        <div ref={stripRef} className="overflow-hidden" style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
          <div className={gridClass} style={gridStyle}>
            <div data-name-head className={`sticky left-0 z-[1] flex items-end self-stretch ${stickyBg} ${nameShadow} pb-1 pr-2 text-[11px] font-semibold text-[var(--muted-2)]`}>
              Page
            </div>
            {pageNumbers.map((p) => (
              <div key={p} data-page-head={p} className="flex items-end self-stretch">
                {pageHeadButton(p)}
              </div>
            ))}
            <div className="flex items-end justify-end self-stretch pb-1 text-[11px] font-semibold text-[var(--muted-2)]">Time</div>
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-matrix
        className="relative overflow-x-auto overflow-y-hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        onMouseLeave={hideTip}
      >
        <div ref={gridRef} className={gridClass} style={gridStyle}>
          <div className="contents">
            <div
              data-name-head
              className={`sticky left-0 top-0 z-[3] flex items-end self-stretch ${stickyBg} ${headShadow} pb-1 pr-2 text-[11px] font-semibold text-[var(--muted-2)] max-sm:hidden`}
            >
              Person
            </div>
            {pageNumbers.map((p) => (
              <div key={p} data-page-head={p} className={`sticky top-0 z-[2] flex items-end self-stretch ${stickyBg} ${headShadow} max-sm:hidden`}>
                {pageHeadButton(p)}
              </div>
            ))}
            <div
              className={`sticky top-0 z-[2] flex items-end justify-end self-stretch ${stickyBg} pb-1 text-[11px] font-semibold text-[var(--muted-2)] max-sm:hidden`}
            >
              Time
            </div>
          </div>

          {rows.map((row) => (
            <div key={row.personId} className="contents">
              <div className={`${nameCell} flex items-center`}>
                <button
                  type="button"
                  data-matrix-row
                  onClick={() => onOpenPerson(row)}
                  className="block w-full min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-[var(--fg)]">
                      {isAnonymous(row) ? (
                        <>
                          <span className="sm:hidden">{displayName(row, true)}</span>
                          <span className="hidden sm:inline">{row.name}</span>
                        </>
                      ) : (
                        row.name
                      )}
                    </span>
                    {row.activeNow ? (
                      <span
                        role="img"
                        aria-label="Active in the last 10 minutes"
                        title="Active in the last 10 minutes"
                        className="relative flex h-2 w-2 shrink-0"
                      >
                        <span className="absolute inset-0 rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
                        <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
                      </span>
                    ) : null}
                    {row.hot ? (
                      <span
                        title={hotReasonText(row.hot)}
                        className="hidden min-w-[4.5rem] shrink-[10] truncate whitespace-nowrap rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-semibold leading-4 text-emerald-700 sm:inline dark:text-emerald-300"
                      >
                        {hotPillText(row.hot)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex min-w-0 flex-nowrap items-center gap-x-1 text-[11px] leading-4 text-[var(--muted)] sm:hidden">
                    {row.hot ? (
                      <span title={hotReasonText(row.hot)} className="min-w-0 truncate font-semibold text-emerald-700 dark:text-emerald-300">
                        {hotPillText(row.hot, false)}
                      </span>
                    ) : (
                      <>
                        {shareId ? null : <span className="min-w-0 truncate">{shortLinkLabel(row.linkLabel)}</span>}
                        <span className="shrink-0 whitespace-nowrap">{`${shareId ? "" : "· "}${formatRelative(row.lastSeen, now)}`}</span>
                      </>
                    )}
                    <span className="ml-auto shrink-0 whitespace-nowrap pl-1 tabular-nums text-[var(--fg)]">{formatDwell(row.totalMs)}</span>
                  </span>
                  <span className="hidden min-w-0 items-center gap-1 text-[11px] text-[var(--muted)] sm:flex">
                    {shareId ? null : <span className="min-w-0 truncate">{row.linkLabel}</span>}
                    <span className="shrink-0">{`${shareId ? "" : "· "}${formatRelative(row.lastSeen, now)}`}</span>
                  </span>
                </button>
              </div>
              {pageNumbers.map((p) => {
                const cell = row.cells[p - 1];
                const kind = cellKind(row, p);
                const step = kind === "read" ? Math.max(1, cellStep(cell?.ms ?? 0)) : 0;
                let fill: React.ReactNode = null;
                let cls = "";
                if (kind === "passed") {
                  fill = <span aria-hidden="true" className="absolute inset-0 rounded-[4px]" style={{ background: PASSED_BG }} />;
                } else if (kind === "jumped") {
                  cls = "border border-[var(--border)]";
                  fill = <span aria-hidden="true" className="absolute inset-0 rounded-[3px]" style={{ background: JUMPED_BG }} />;
                } else if (kind === "unknown") {
                  cls = "border border-dotted border-[var(--muted-2)]";
                } else if (kind === "unreached") {
                  // The fill alone nearly matches the card in dark mode; the border keeps the cell visible.
                  cls = "border border-[var(--border)]";
                  fill = <span aria-hidden="true" className="absolute inset-0 rounded-[3px] bg-[var(--panel-hover)] opacity-60" />;
                }
                return (
                  <button
                    key={p}
                    type="button"
                    data-matrix-cell
                    aria-label={cellText(row, p, pages)}
                    onMouseEnter={(e) => showCellTip(e.currentTarget, row, p)}
                    onFocus={(e) => showCellTip(e.currentTarget, row, p)}
                    onMouseLeave={hideTip}
                    onBlur={hideTip}
                    onClick={(e) => onCellClick(e.currentTarget, row, p)}
                    className={`relative flex h-7 w-full items-center justify-center rounded-[4px] before:absolute before:-inset-[2px] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${cls}`}
                    style={step > 0 ? { backgroundColor: `var(--mx-${step})`, color: `var(--mx-t-${step})` } : undefined}
                  >
                    {fill}
                    {step > 0 && showCellText ? (
                      <span aria-hidden="true" className="relative text-[10px] font-medium leading-none tabular-nums">
                        {formatCellDwell(cell?.ms ?? 0)}
                      </span>
                    ) : null}
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
              <div className="whitespace-nowrap text-right text-[11px] leading-4 tabular-nums text-[var(--fg)]">
                {formatDwell(row.totalMs)}
                <span data-matrix-stayed className="block text-[10px] text-[var(--muted)]">
                  {`${row.readPages}/${pageCount}`}
                  <span className="hidden sm:inline"> stayed</span>
                </span>
              </div>
            </div>
          ))}

          <div className="contents sm:hidden" aria-hidden="true">
            <div className={`${nameCell} border-t border-[var(--border)] pt-2 text-[11px] font-semibold text-[var(--muted-2)]`}>Page</div>
            {pageNumbers.map((p) => (
              <div key={p} className="self-stretch border-t border-[var(--border)] pt-2 text-center text-[11px] font-medium tabular-nums text-[var(--muted)]">
                {p}
              </div>
            ))}
            <div className="self-stretch border-t border-[var(--border)]" />
          </div>
          {footerRow("Reached", REACHED_TOOLTIP, (p) => footerValue(pages[p - 1]?.reached ?? 0, false), true)}
          {footerRow("Typical time", TYPICAL_TOOLTIP, (p) => {
            const t = typicalDisplay(pages[p - 1]);
            if (t.kind === "ranked") {
              return (
                <span className={bold.typical.has(p) ? "font-semibold text-[var(--fg)]" : "text-[var(--fg)]"}>{formatCellDwell(t.ms)}</span>
              );
            }
            if (t.kind === "thin") {
              return (
                <span role="img" aria-label={`${formatDwell(t.ms)}; ${t.title}`} title={t.title} className="text-[var(--muted-2)]">
                  {formatCellDwell(t.ms)}
                </span>
              );
            }
            if (t.kind === "few") {
              return (
                <span role="img" aria-label={t.text} title={t.text} className="text-[var(--muted-2)]">
                  —
                </span>
              );
            }
            return <span className="text-[var(--muted-2)]">—</span>;
          })}
          {footerRow("Skipped", SKIPPED_TOOLTIP, (p) => {
            const pg = pages[p - 1];
            const detail = pg ? skippedBreakdown(pg.passed, pg.jumped) : null;
            return footerValue(pg ? pg.passed + pg.jumped : 0, bold.skipped.has(p), detail ?? undefined);
          })}
          {footerRow("Left here", LEFT_TOOLTIP, (p) => footerValue(pages[p - 1]?.leftHere ?? 0, bold.left.has(p)))}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {caption}
      </p>

      {tip ? (
        <div
          ref={tipRef}
          key={tip.key}
          role={tip.pinned ? "dialog" : "tooltip"}
          data-matrix-popover
          className={`${tip.pinned ? "pointer-events-auto" : "pointer-events-none"} fixed left-0 top-0 z-50 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2 shadow-lg`}
          style={{ visibility: "hidden" }}
        >
          {tip.content}
        </div>
      ) : null}

      {total > rows.length && limit < MATRIX_ALL_LIMIT ? (
        <button
          type="button"
          onClick={onShowAll}
          disabled={loadingAll}
          className="mt-3 inline-flex h-11 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60 sm:h-9"
        >
          {loadingAll
            ? "Loading…"
            : total > MATRIX_ALL_LIMIT
              ? `Show the ${MATRIX_ALL_LIMIT} most recent people`
              : `Show all ${total} people`}
        </button>
      ) : null}
    </div>
  );
}
