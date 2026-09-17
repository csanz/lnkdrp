/**
 * Page by page: one row per page with this person's time as a bar, a dashed tick for the page's
 * typical time, and the passed / skipped / not-recorded / not-reached states.
 * Runs of three or more unreached pages collapse into one row.
 */
"use client";

import { useState } from "react";
import { formatDwell, formatDwellCompact } from "@/lib/analytics/reading/format";
import type { PersonPageRow } from "@/lib/analytics/reading/types";

const EMERALD = "rgb(16 185 129)";
/** Time up to the typical time; the part past it is full EMERALD so above-typical time stands out. */
const EMERALD_SOFT = "rgb(16 185 129 / .45)";
const EMERALD_DARK = "rgb(4 120 87)";
const HATCH = "repeating-linear-gradient(45deg, rgb(16 185 129 / .45) 0 2px, transparent 2px 5px)";
const MUTED_HATCH = "repeating-linear-gradient(45deg, rgb(113 113 122 / .4) 0 2px, transparent 2px 5px)";
/** Floor for the bar scale so a single short stay doesn't draw a full-width bar. */
const MIN_DOMAIN_MS = 30_000;
/** One outlier may stretch the scale to this multiple of the next-largest value, no further. */
const OUTLIER_FACTOR = 2;
/** Typical times from fewer stayed readers than this draw a muted tick. */
const TYPICAL_SOLID_FROM = 5;
/** Row ratios are shown from this multiple of the typical time. */
const RATIO_SHOWN_FROM = 2;
const COLLAPSE_MIN_RUN = 3;
const NBSP = "\u00a0";

function Thumb({ page, thumbUrl }: { page: number; thumbUrl: string | null }) {
  return (
    <div className="row-span-2 h-[42px] w-14 shrink-0 overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--panel)] sm:row-span-1">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt="" loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] font-semibold text-[var(--muted-2)]">
          {String(page)}
        </span>
      )}
    </div>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-px text-[10px] font-semibold text-[var(--muted-2)]">
      {children}
    </span>
  );
}

function Stub({ hatch, text }: { hatch: string; text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="h-2.5 w-3 shrink-0 rounded-sm" style={{ backgroundImage: hatch }} />
      <span className="truncate text-[12px] text-[var(--muted)]">{text}</span>
    </div>
  );
}

function BreakCap() {
  return (
    <span
      aria-hidden="true"
      className="absolute left-full top-1/2 -translate-y-1/2 pl-0.5 text-[13px] font-semibold leading-none"
      style={{ color: EMERALD_DARK }}
    >
      ›
    </span>
  );
}

/**
 * Bar scale shared by every row: the largest time (this person's, or a typical time on a row that
 * draws a tick), capped at twice the second largest so one long stay can't flatten every other bar;
 * at least 30s.
 */
export function pageBarDomainMs(pages: PersonPageRow[]): number {
  const values: number[] = [];
  for (const r of pages) {
    if ((r.state === "read" || r.state === "passed") && r.ms > 0) values.push(r.ms);
    if (r.state === "read" && r.typicalMs !== null && r.typicalMs > 0) values.push(r.typicalMs);
  }
  values.sort((a, b) => b - a);
  const largest = values[0] ?? 0;
  const capped = values.length > 1 ? Math.min(largest, OUTLIER_FACTOR * values[1]) : largest;
  return Math.max(MIN_DOMAIN_MS, capped);
}

/** "8.7×", with the same one decimal as the header chip so the two never disagree. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}×`;
}

/** True when some row draws a typical-time tick (a stayed page with a typical time). */
export function hasTypicalTick(pages: PersonPageRow[]): boolean {
  return pages.some((r) => r.state === "read" && r.typicalMs !== null);
}

/** True when some stayed row runs past its typical time (the full-emerald part of a bar). */
export function hasAboveTypical(pages: PersonPageRow[]): boolean {
  return pages.some((r) => r.state === "read" && r.typicalMs !== null && r.ms > r.typicalMs);
}

/** "typical 8s", or "typical 8s · 8.7×" when the API's ratio is twice the typical time or more. */
export function typicalValueText(row: PersonPageRow): string | null {
  if (row.typicalMs === null || row.state === "unreached") return null;
  const base = `typical ${formatDwellCompact(row.typicalMs)}`;
  const ratio = row.ratio ?? null;
  if (row.state !== "read" || ratio === null || ratio < RATIO_SHOWN_FROM) return base;
  return `${base} · ${formatRatio(ratio)}`;
}

/** Inline key for the section header: the bar swatch, the typical tick and, when drawn, above-typical time. */
export function PageBarsKey({ pages }: { pages: PersonPageRow[] }) {
  return (
    <span data-page-bars-key className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2.5 w-2 rounded-sm" style={{ backgroundColor: EMERALD_SOFT }} />
        their time
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-3 w-0 border-l border-dashed border-[var(--muted)]" />
        typical
      </span>
      {hasAboveTypical(pages) ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2 rounded-sm" style={{ backgroundColor: EMERALD }} />
          more than typical
        </span>
      ) : null}
    </span>
  );
}

function PageBarRow({
  row,
  domainMs,
  highlighted,
  hidden,
  compared,
}: {
  row: PersonPageRow;
  domainMs: number;
  highlighted: boolean;
  hidden: boolean;
  /** Some row has a typical tick, so bars use the soft/full two-tone that the key explains. */
  compared: boolean;
}) {
  const state = row.state;
  const barClipped = state === "read" && row.ms > domainMs;
  const pct = row.ms > 0 ? Math.min(100, (row.ms / domainMs) * 100) : 0;
  const tickClipped = row.typicalMs !== null && row.typicalMs > domainMs;
  const tickPct = state === "read" && row.typicalMs !== null ? Math.min(100, (row.typicalMs / domainMs) * 100) : null;
  const tickMuted = row.readCount < TYPICAL_SOLID_FROM;
  // Share of the drawn bar that sits past the typical time, so above-typical time shows at any scale.
  const aboveTypicalPct =
    state === "read" && row.typicalMs !== null && row.ms > row.typicalMs
      ? 100 - (Math.min(row.typicalMs, domainMs) / Math.min(row.ms, domainMs)) * 100
      : 0;

  let track: React.ReactNode;
  let value: string;
  if (state === "read") {
    track = (
      <div className="relative h-2.5" style={{ width: `${pct}%`, minWidth: row.ms > 0 ? 2 : 0 }}>
        <div className="relative h-full overflow-hidden rounded-full" style={{ backgroundColor: compared ? EMERALD_SOFT : EMERALD }}>
          {aboveTypicalPct > 0 ? (
            <div
              data-above-typical
              className="absolute inset-y-0 right-0"
              style={{ width: `${aboveTypicalPct}%`, backgroundColor: EMERALD }}
            />
          ) : null}
        </div>
        {barClipped ? <BreakCap /> : null}
      </div>
    );
    value = formatDwell(row.ms);
  } else if (state === "passed") {
    track = <Stub hatch={HATCH} text="Passed" />;
    value = "<2s";
  } else if (state === "jumped") {
    track = <Stub hatch={MUTED_HATCH} text="Skipped" />;
    value = "—";
  } else if (state === "unknown") {
    track = <span className="block truncate text-[12px] text-[var(--muted)]">Time not recorded</span>;
    value = "—";
  } else {
    track = <span className="block truncate text-[12px] text-[var(--muted)]">Not reached</span>;
    value = "—";
  }

  const typicalText = typicalValueText(row);

  return (
    <li
      data-reader-page={row.page}
      hidden={hidden}
      className={`grid grid-cols-[56px_minmax(0,1fr)_5.5rem] items-center gap-x-3 gap-y-1 rounded-lg py-2 transition-colors duration-500 sm:grid-cols-[56px_12rem_minmax(0,1fr)_5.5rem] ${
        state === "unreached" ? "opacity-50" : ""
      } ${highlighted ? "bg-emerald-500/10" : ""}`}
    >
      <Thumb page={row.page} thumbUrl={row.thumbUrl} />
      <div className="col-span-2 line-clamp-1 min-w-0 text-[13px] sm:col-span-1 sm:line-clamp-none">
        <span className="font-semibold text-[var(--fg)]">{`Page ${row.page}`}</span>
        {row.label ? (
          <>
            <span className="text-[var(--muted)] sm:hidden"> · </span>
            <span className="text-[12px] text-[var(--muted)] sm:line-clamp-2 sm:text-[11px]" title={row.label}>
              {row.label}
            </span>
          </>
        ) : null}
      </div>
      <div className="min-w-0">
        {/* The plot stops 12px short of the track so a break cap or clipped tick has room. */}
        <div className="flex h-5 items-center pr-3">
          <div className="relative flex h-full min-w-0 flex-1 items-center">
            <div className="min-w-0 flex-1">{track}</div>
            {tickPct !== null ? (
              <span
                data-typical-tick
                data-tick-muted={tickMuted ? "" : undefined}
                aria-hidden="true"
                className={`absolute inset-y-0 w-0 border-l border-dashed border-[var(--muted)] ${tickMuted ? "opacity-40" : ""}`}
                style={{ left: `${tickPct}%` }}
              >
                {tickClipped ? (
                  <span className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[12px] leading-none text-[var(--muted)]">›</span>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        {row.revisits > 0 || row.leftHere ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.revisits > 0 ? <Badge>↺ went back</Badge> : null}
            {row.leftHere ? <Badge>Left here</Badge> : null}
          </div>
        ) : null}
      </div>
      <div className="self-start text-right leading-tight">
        <div className="pt-0.5 text-[13px] tabular-nums text-[var(--fg)]">{value}</div>
        <div className="whitespace-nowrap text-[11px] tabular-nums text-[var(--muted)]">{typicalText ?? NBSP}</div>
      </div>
    </li>
  );
}

type Segment = { kind: "row"; row: PersonPageRow } | { kind: "range"; rows: PersonPageRow[] };

/** Rows in page order, with each run of three or more unreached pages grouped. */
export function pageBarSegments(pages: PersonPageRow[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < pages.length) {
    if (pages[i].state !== "unreached") {
      out.push({ kind: "row", row: pages[i] });
      i += 1;
      continue;
    }
    let j = i;
    while (j < pages.length && pages[j].state === "unreached") j += 1;
    const run = pages.slice(i, j);
    if (run.length >= COLLAPSE_MIN_RUN) out.push({ kind: "range", rows: run });
    else for (const row of run) out.push({ kind: "row", row });
    i = j;
  }
  return out;
}

function CollapsedRange({
  rows,
  domainMs,
  highlightPage,
  revealPage,
  compared,
}: {
  rows: PersonPageRow[];
  domainMs: number;
  highlightPage: number | null;
  revealPage: number | null;
  compared: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const first = rows[0].page;
  const last = rows[rows.length - 1].page;
  const expanded = open ?? (revealPage !== null && revealPage >= first && revealPage <= last);
  return (
    <>
      <li data-reader-page-range={`${first}-${last}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <span className="text-[13px] text-[var(--muted)]">
          <span className="font-semibold text-[var(--fg)] opacity-60">{`Pages ${first}–${last}`}</span>
          {" · not reached"}
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className="inline-flex h-11 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-8 sm:px-2.5 sm:text-[12px]"
        >
          {expanded ? "Hide pages" : "Show pages"}
        </button>
      </li>
      {rows.map((row) => (
        <PageBarRow
          key={row.page}
          row={row}
          domainMs={domainMs}
          highlighted={highlightPage === row.page}
          hidden={!expanded}
          compared={compared}
        />
      ))}
    </>
  );
}

/** One row per page (1..P); long unreached tails collapse behind "Show pages". */
export default function ReaderPageBars({
  pages,
  highlightPage = null,
  revealPage = null,
}: {
  pages: PersonPageRow[];
  highlightPage?: number | null;
  /** Page that must be visible (expands its collapsed range), e.g. the page a matrix cell opened. */
  revealPage?: number | null;
}) {
  const domainMs = pageBarDomainMs(pages);
  const compared = hasTypicalTick(pages);
  return (
    <ul className="divide-y divide-[var(--divider)]">
      {pageBarSegments(pages).map((seg) =>
        seg.kind === "row" ? (
          <PageBarRow
            key={seg.row.page}
            row={seg.row}
            domainMs={domainMs}
            highlighted={highlightPage === seg.row.page}
            hidden={false}
            compared={compared}
          />
        ) : (
          <CollapsedRange
            key={`range-${seg.rows[0].page}`}
            rows={seg.rows}
            domainMs={domainMs}
            highlightPage={highlightPage}
            revealPage={revealPage}
            compared={compared}
          />
        ),
      )}
    </ul>
  );
}
