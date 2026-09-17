/**
 * Visits for one person, newest first: a ribbon of stops sized by time, the page path with the
 * exit, passed pages, and "came back … later" dividers between visits an hour or more apart.
 */
"use client";

import { useState } from "react";
import { formatDwell, formatGap } from "@/lib/analytics/reading/format";
import type { PersonVisitRow } from "@/lib/analytics/reading/types";

const INITIAL_VISITS = 5;
const RETURN_DIVIDER_MS = 3_600_000;
const EMERALD = "rgb(16 185 129)";
const EMERALD_DARK = "rgb(4 120 87)";

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

/** "1 → 2 → 3 · left on page 3" or "… · ended on the last page". */
export function visitPathText(visit: PersonVisitRow, pageCount: number): string {
  const path = visit.stops.map((s) => String(s.page)).join(" → ");
  if (visit.exitPage === null) return path;
  const end = visit.exitPage === pageCount ? "ended on the last page" : `left on page ${visit.exitPage}`;
  return path ? `${path} · ${end}` : end;
}

function Ribbon({ visit, pageCount }: { visit: PersonVisitRow; pageCount: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  const total = visit.stops.length;
  const caption =
    selected !== null && visit.stops[selected]
      ? `Page ${visit.stops[selected].page} · ${formatDwell(visit.stops[selected].ms)} · stop ${selected + 1} of ${total}`
      : null;

  return (
    <div className="space-y-2">
      <div data-ribbon className="overflow-x-auto">
        <div
          className="flex h-7 gap-0.5 min-w-[max(100%,var(--ribbon-min))] sm:min-w-0"
          style={{ ["--ribbon-min" as string]: `${total * 24}px` }}
        >
          {visit.stops.map((stop, i) => {
            const label = `Page ${stop.page} · ${formatDwell(stop.ms)}`;
            return (
              <button
                key={i}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected === i}
                onClick={() => setSelected((cur) => (cur === i ? null : i))}
                className="@container relative flex min-w-[6px] items-center justify-center overflow-hidden rounded-[4px] text-[10px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                style={{
                  flexGrow: Math.max(1, stop.ms),
                  flexBasis: 0,
                  backgroundColor: EMERALD,
                  boxShadow: stop.revisit ? `inset 0 0 0 2px ${EMERALD_DARK}` : undefined,
                  opacity: selected !== null && selected !== i ? 0.7 : 1,
                }}
              >
                <span aria-hidden="true" className="hidden @min-[20px]:inline">
                  {String(stop.page)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="min-h-4 text-[11px] text-[var(--muted)]" aria-live="polite">
        {caption}
      </p>
      <p className="text-[13px] text-[var(--fg)]">{visitPathText(visit, pageCount)}</p>
      {visit.passedPages.length > 0 ? (
        <p className="text-[12px] text-[var(--muted)]">
          {visit.passedPages.length === 1
            ? `Passed: page ${visit.passedPages[0]}`
            : `Passed: pages ${visit.passedPages.join(", ")}`}
        </p>
      ) : null}
    </div>
  );
}

function VisitCard({ visit, pageCount }: { visit: PersonVisitRow; pageCount: number }) {
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4" data-reader-visit>
      <div className="mb-3 text-[13px] font-semibold text-[var(--fg)]">
        {`${formatVisitStart(visit.startedAt)} · ${formatDwell(visit.totalMs)}`}
      </div>
      {visit.timed && visit.stops.length > 0 ? (
        <Ribbon visit={visit} pageCount={pageCount} />
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
}: {
  visits: PersonVisitRow[];
  pageCount: number;
  moreVisits: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? visits : visits.slice(0, INITIAL_VISITS);
  const hidden = visits.length - shown.length;

  const items: React.ReactNode[] = [];
  shown.forEach((visit, i) => {
    if (i > 0) {
      const newer = shown[i - 1];
      const gap = Date.parse(newer.startedAt) - Date.parse(visit.endedAt);
      if (Number.isFinite(gap) && gap >= RETURN_DIVIDER_MS) {
        items.push(
          <li key={`gap-${visit.visitId}`} className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
            <span className="h-px flex-1 bg-[var(--divider)]" />
            <span>{`came back ${formatGap(gap)} later`}</span>
            <span className="h-px flex-1 bg-[var(--divider)]" />
          </li>,
        );
      }
    }
    items.push(<VisitCard key={visit.visitId} visit={visit} pageCount={pageCount} />);
  });

  return (
    <div className="space-y-3">
      <ol className="space-y-3">{items}</ol>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
