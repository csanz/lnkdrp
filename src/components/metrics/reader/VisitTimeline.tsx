/**
 * Visits for one person, newest first: a ribbon of stops sized by time, the page path with the
 * exit, under-2s pages, and "… earlier" dividers between visits an hour or more apart.
 */
"use client";

import { useState } from "react";
import { formatDwell, formatReturnGap } from "@/lib/analytics/reading/format";
import type { PersonVisitRow } from "@/lib/analytics/reading/types";

const INITIAL_VISITS = 5;
const RETURN_DIVIDER_MS = 3_600_000;
const EMERALD = "rgb(16 185 129)";
const EMERALD_DARK = "rgb(4 120 87)";
const PASSED_PX = 8;
const UNTIMED_PX = 16;
/** Floor for a timed stop's drawn width; its hit area reaches past it into the gaps. */
const TIMED_MIN_PX = 6;
/** Tailwind `gap-0.5`. */
const SEGMENT_GAP_PX = 2;

/** "Wed, Sep 10, 1:42 PM" in the viewer's time zone; "—" when unparseable. */
export function formatVisitStart(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** [1,2,3,5,7,8] → "1–3, 5, 7–8". */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

type Stop = PersonVisitRow["stops"][number];

/** The path's noun ("Page"/"Pages"), its steps and its ending ("left on page 3"), each null/empty when absent. */
export function visitPathParts(visit: PersonVisitRow, pageCount: number): { noun: string; steps: string[]; end: string | null } {
  const steps: string[] = [];
  for (let i = 0; i < visit.stops.length; i += 1) {
    const s = visit.stops[i];
    if (s.untimed) {
      const run = [s.page];
      while (i + 1 < visit.stops.length && visit.stops[i + 1].untimed) {
        i += 1;
        run.push(visit.stops[i].page);
      }
      steps.push(`${run.join(", ")} (time not recorded)`);
    } else {
      steps.push(s.passed ? `${s.page} (under 2s)` : String(s.page));
    }
  }
  const noun = visit.stops.length === 1 ? "Page" : "Pages";
  const end =
    visit.exitPage === null ? null : visit.exitPage === pageCount ? "ended on the last page" : `left on page ${visit.exitPage}`;
  return { noun, steps, end };
}

/**
 * "Pages 1 → 12 (under 2s) → 3 · left on page 3" or "… · ended on the last page". Consecutive
 * untimed steps share one note: "6, 7, 8 (time not recorded)".
 */
export function visitPathText(visit: PersonVisitRow, pageCount: number): string {
  const { noun, steps, end } = visitPathParts(visit, pageCount);
  const path = steps.length > 0 ? `${noun} ${steps.join(" → ")}` : "";
  if (end === null) return path;
  return path ? `${path} · ${end}` : end;
}

function isTimedStop(s: Stop): boolean {
  return !s.passed && !s.untimed && s.ms > 0;
}

/**
 * "Page 10 47s · Page 11 17s · Page 1 7s": the three pages with the most time in this visit; null when
 * the visit has two timed stops or fewer (the path already says it all).
 */
export function visitTopPagesText(visit: PersonVisitRow): string | null {
  const timed = visit.stops.filter(isTimedStop);
  if (timed.length <= 2) return null;
  const byPage = new Map<number, number>();
  for (const s of timed) byPage.set(s.page, (byPage.get(s.page) ?? 0) + s.ms);
  const top = [...byPage.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
  return top.map(([page, ms]) => `Page ${page} ${formatDwell(ms)}`).join(" · ");
}

/** "4 days later" → "4 days earlier"; "the next day" → "the day before". */
export function earlierGapText(fromMs: number, toMs: number): string {
  const later = formatReturnGap(fromMs, toMs);
  return later === "the next day" ? "the day before" : later.replace(/ later$/, " earlier");
}

/** Key entries for the segment styles that appear in these visits, in a fixed order. */
export function ribbonKeyText(visits: PersonVisitRow[]): string | null {
  const stops = visits.filter(hasRibbon).flatMap((v) => v.stops);
  const parts: string[] = [];
  if (stops.some((s) => s.passed)) parts.push("hatched = under 2s");
  if (stops.some((s) => s.revisit && !s.passed && !s.untimed)) parts.push("outlined = went back");
  if (stops.some((s) => s.untimed)) parts.push("dotted = time not recorded");
  return parts.length > 0 ? parts.join(" · ") : null;
}

function hasRibbon(visit: PersonVisitRow): boolean {
  return visit.timed && visit.stops.length > 0;
}

function visitDurationMs(visit: PersonVisitRow): number {
  if (visit.totalMs > 0) return visit.totalMs;
  return visit.stops.reduce((sum, s) => sum + Math.max(0, s.ms), 0);
}

function stopLabel(stop: Stop): string {
  if (stop.untimed) return `Page ${stop.page} · time not recorded`;
  return `Page ${stop.page} · ${stop.passed ? "under 2s" : formatDwell(stop.ms)}`;
}

const PASSED_HATCH = "repeating-linear-gradient(45deg, rgb(16 185 129 / .55) 0 2px, transparent 2px 4px)";

/** Past this many characters the last step and ending could outgrow a phone card on one line. */
const NOWRAP_ENDING_CHARS = 40;

/**
 * A short ending stays on the last step's line, so a wrap never leaves "· left on page 10" on its own;
 * a long one wraps as a whole phrase.
 */
function VisitPath({ visit, pageCount }: { visit: PersonVisitRow; pageCount: number }) {
  const { noun, steps, end } = visitPathParts(visit, pageCount);
  if (steps.length === 0) return <p className="text-[13px] text-[var(--fg)]">{end}</p>;
  const last = steps.length - 1;
  return (
    <p className="text-[13px] text-[var(--fg)]">
      {steps.map((step, i) => {
        const head = i === 0 ? `${noun} ${step}` : `→ ${step}`;
        const lead = i === 0 ? null : " ";
        if (i < last || end === null) {
          return (
            <span key={i}>
              {lead}
              <span className="whitespace-nowrap">{head}</span>
            </span>
          );
        }
        const whole = `${head} · ${end}`;
        if (whole.length <= NOWRAP_ENDING_CHARS) {
          return (
            <span key={i}>
              {lead}
              <span className="whitespace-nowrap">{whole}</span>
            </span>
          );
        }
        // Long (e.g. an untimed run): the ending moves to the next line whole, never split mid-phrase.
        return (
          <span key={i}>
            {lead}
            <span className="whitespace-nowrap">{head}</span>{" "}
            <span className="whitespace-nowrap">{`· ${end}`}</span>
          </span>
        );
      })}
    </p>
  );
}

type Scale = {
  /** Visit length that fills the card. */
  referenceMs: number;
  typicalTotalMs: number | null;
};

function Ribbon({
  visit,
  pageCount,
  scale,
  keyText,
}: {
  visit: PersonVisitRow;
  pageCount: number;
  scale: Scale;
  keyText: string | null;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const stops: Stop[] = visit.stops;
  const total = stops.length;
  const passedCount = stops.filter((s) => s.passed && !s.untimed).length;
  const untimedCount = stops.filter((s) => s.untimed).length;
  const timedCount = total - passedCount - untimedCount;
  const selectedStop = selected !== null ? stops[selected] : undefined;
  const caption = selectedStop ? `${stopLabel(selectedStop)} · stop ${(selected ?? 0) + 1} of ${total}` : null;
  const pathPages = new Set(stops.map((s) => s.page));
  const passedNotInPath = visit.passedPages.filter((p) => !pathPages.has(p));
  const topPages = visitTopPagesText(visit);
  // Width follows the visit's length against the longest visit shown (or the typical person's total
  // when longer), at every screen width, so an 8s bounce reads short. The pixel floor only keeps each
  // stop tappable; past the card's width the row wraps instead of scrolling.
  const { referenceMs, typicalTotalMs } = scale;
  const widthPct = referenceMs > 0 ? Math.min(100, (visitDurationMs(visit) / referenceMs) * 100) : 100;
  const fixedPx = passedCount * PASSED_PX + untimedCount * UNTIMED_PX + Math.max(0, total - 1) * SEGMENT_GAP_PX;
  const typicalPct =
    typicalTotalMs !== null && typicalTotalMs > 0 && referenceMs > 0 && typicalTotalMs <= referenceMs
      ? (typicalTotalMs / referenceMs) * 100
      : null;
  const rowStyle = {
    "--ribbon-w": `${widthPct}%`,
    "--ribbon-min": `${TIMED_MIN_PX * timedCount + fixedPx}px`,
    width: "max(var(--ribbon-w), var(--ribbon-min))",
  } as React.CSSProperties;

  return (
    <div className="space-y-2">
      <div data-ribbon className="relative overflow-visible">
        {/* `isolate` keeps the hit areas' -z-10 inside the row: above the card, below every stop's own box,
            so a neighbour's hit area never covers a narrow stop. */}
        <div data-ribbon-row className="isolate flex max-w-full flex-wrap gap-0.5" style={rowStyle}>
          {stops.map((stop, i) => {
            const label = stopLabel(stop);
            const passed = stop.passed && !stop.untimed;
            let style: React.CSSProperties;
            let look: React.CSSProperties;
            if (stop.untimed) {
              style = { flex: `0 0 ${UNTIMED_PX}px` };
              look = {};
            } else if (passed) {
              style = { flex: `0 0 ${PASSED_PX}px` };
              look = { backgroundImage: PASSED_HATCH };
            } else {
              style = {
                "--seg-flex": `${Math.max(1, stop.ms)} 1 0px`,
                flex: "var(--seg-flex)",
                minWidth: TIMED_MIN_PX,
              } as React.CSSProperties;
              look = { backgroundColor: EMERALD, boxShadow: stop.revisit ? `inset 0 0 0 2px ${EMERALD_DARK}` : undefined };
            }
            // Fill, dimming and the @container (all of which make stacking contexts) sit on the inner span,
            // so the button stays out of the way and its hit area can drop below its neighbours.
            return (
              <button
                key={i}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected === i}
                onClick={() => setSelected((cur) => (cur === i ? null : i))}
                className={`relative h-11 rounded-[4px] text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-7 ${
                  stop.untimed ? "text-[var(--fg)]" : "text-white before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:content-['']"
                }`}
                style={style}
              >
                <span
                  aria-hidden="true"
                  className={`@container absolute inset-0 flex items-center justify-center overflow-hidden rounded-[4px] ${
                    stop.untimed ? "border border-dotted border-[var(--fg)]/50" : ""
                  }`}
                  style={{ ...look, opacity: selected !== null && selected !== i ? 0.7 : 1 }}
                >
                  {passed ? null : <span className="hidden @min-[16px]:inline">{String(stop.page)}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {typicalPct !== null ? (
          <span
            data-typical-visit
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 block w-0 border-l border-dashed border-[var(--muted)] opacity-60"
            style={{ left: `min(${typicalPct}%, calc(100% - 1px))` }}
          />
        ) : null}
      </div>
      {typicalPct !== null && typicalTotalMs !== null ? (
        <div className="relative h-3.5">
          <span
            className={`absolute top-0 whitespace-nowrap text-[10px] leading-none text-[var(--muted)] ${typicalPct > 50 ? "-translate-x-full pr-1" : "pl-1"}`}
            style={{ left: `${typicalPct}%` }}
          >
            {`typical person ${formatDwell(typicalTotalMs)}`}
          </span>
        </div>
      ) : null}
      {keyText ? (
        <p data-ribbon-key className="text-[11px] text-[var(--muted)]">
          {keyText}
        </p>
      ) : null}
      {topPages ? <p className="text-[11px] tabular-nums text-[var(--muted)]">{topPages}</p> : null}
      {caption ? (
        <p className="text-[11px] text-[var(--fg)]" aria-live="polite">
          {caption}
        </p>
      ) : null}
      <VisitPath visit={visit} pageCount={pageCount} />
      {passedNotInPath.length > 0 ? (
        <p className="text-[12px] text-[var(--muted)]">
          {passedNotInPath.length === 1
            ? `Under 2s: page ${passedNotInPath[0]}`
            : `Under 2s: pages ${passedNotInPath.join(", ")}`}
        </p>
      ) : null}
    </div>
  );
}

function VisitCard({
  visit,
  pageCount,
  scale,
  keyText,
  number,
  total,
}: {
  visit: PersonVisitRow;
  pageCount: number;
  scale: Scale;
  keyText: string | null;
  /** 1 for the oldest visit. */
  number: number;
  total: number;
}) {
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4" data-reader-visit>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[13px] font-semibold text-[var(--fg)]">
          {`${formatVisitStart(visit.startedAt)} · ${formatDwell(visit.totalMs)}`}
        </span>
        {total > 1 ? <span className="text-[11px] text-[var(--muted)]">{`Visit ${number} of ${total}`}</span> : null}
      </div>
      {hasRibbon(visit) ? (
        <Ribbon visit={visit} pageCount={pageCount} scale={scale} keyText={keyText} />
      ) : (
        <div className="space-y-1">
          <p className="text-[13px] text-[var(--fg)]">Time on pages wasn&apos;t recorded for this visit.</p>
          {visit.seen.length > 0 ? (
            <p className="text-[12px] text-[var(--muted)]">{`Pages seen: ${formatPageRanges(visit.seen)}`}</p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Newest first; five cards, then "Show {k} earlier visits". */
export default function VisitTimeline({
  visits,
  pageCount,
  moreVisits,
  typicalTotalMs = null,
}: {
  visits: PersonVisitRow[];
  pageCount: number;
  moreVisits: number;
  /** The typical person's total time, drawn as a marker on each ribbon when it fits the scale. */
  typicalTotalMs?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? visits : visits.slice(0, INITIAL_VISITS);
  const hidden = visits.length - shown.length;
  const ribbons = shown.filter(hasRibbon);
  const longestMs = ribbons.reduce((max, v) => Math.max(max, visitDurationMs(v)), 0);
  const scale: Scale = {
    referenceMs: Math.max(longestMs, typicalTotalMs ?? 0),
    typicalTotalMs,
  };
  const totalVisits = visits.length + moreVisits;
  const keyText = ribbonKeyText(shown);
  const firstRibbonId = shown.find(hasRibbon)?.visitId ?? null;

  const items: React.ReactNode[] = [];
  shown.forEach((visit, i) => {
    if (i > 0) {
      const newer = shown[i - 1];
      const endedMs = Date.parse(visit.endedAt);
      const startedMs = Date.parse(newer.startedAt);
      const gap = startedMs - endedMs;
      if (Number.isFinite(gap) && gap >= RETURN_DIVIDER_MS) {
        items.push(
          <li key={`gap-${visit.visitId}`} className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
            <span className="h-px flex-1 bg-[var(--divider)]" />
            <span>{earlierGapText(endedMs, startedMs)}</span>
            <span className="h-px flex-1 bg-[var(--divider)]" />
          </li>,
        );
      }
    }
    items.push(
      <VisitCard
        key={visit.visitId}
        visit={visit}
        pageCount={pageCount}
        scale={scale}
        keyText={visit.visitId === firstRibbonId ? keyText : null}
        number={totalVisits - i}
        total={totalVisits}
      />,
    );
  });

  return (
    <div className="space-y-3">
      <ol className="space-y-3">{items}</ol>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex h-11 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-9"
        >
          {hidden === 1 ? "Show 1 earlier visit" : `Show ${hidden} earlier visits`}
        </button>
      ) : null}
      {(expanded || hidden === 0) && moreVisits > 0 ? (
        <p className="text-[12px] text-[var(--muted)]">
          {moreVisits === 1 ? "1 older visit isn't listed." : `${moreVisits} older visits aren't listed.`}
        </p>
      ) : null}
    </div>
  );
}
