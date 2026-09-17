/**
 * Page highlights: which page held attention longest, which was most passed over, and where the
 * most people left. Shown only with enough people; otherwise the server's gate sentence is shown.
 */
"use client";

import { formatDwell } from "@/lib/analytics/reading/format";
import type { Callouts, PageRow } from "@/lib/analytics/reading/types";
import { tileLabelClass } from "./KpiStrip";

export type PageCalloutsProps = {
  callouts: Callouts | null;
  calloutGate: string | null;
  pages: PageRow[];
};

const HIGHLIGHT = "bg-emerald-500/10";

/** Scroll the page table row into view and tint it for 2 seconds. */
export function jumpToPageRow(page: number) {
  const el = document.getElementById(`page-row-${page}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add(HIGHLIGHT);
  window.setTimeout(() => el.classList.remove(HIGHLIGHT), 2000);
}

function CalloutCard({ title, page, pages, detail }: { title: string; page: number; pages: PageRow[]; detail: string }) {
  const row = pages[page - 1];
  return (
    <button
      type="button"
      data-callout
      onClick={() => jumpToPageRow(page)}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-2)] text-[12px] font-semibold text-[var(--muted)]">
        {row?.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          page
        )}
      </span>
      <span className="min-w-0">
        <span className={`block ${tileLabelClass}`}>{title}</span>
        <span className="mt-0.5 block truncate text-[13px] font-semibold text-[var(--fg)]">
          {`Page ${page}${row?.label ? ` · ${row.label}` : ""}`}
        </span>
        <span className="block text-[12px] text-[var(--muted)]">{detail}</span>
      </span>
    </button>
  );
}

/** Callout cards, or the gate sentence when callouts are withheld. */
export default function PageCallouts({ callouts, calloutGate, pages }: PageCalloutsProps) {
  if (!callouts) {
    return calloutGate ? (
      <p data-callout-gate className="text-[12px] text-[var(--muted)]">
        {calloutGate}
      </p>
    ) : null;
  }
  const { heldLongest, mostPassed, mostLeft } = callouts;
  if (!heldLongest && !mostPassed && !mostLeft) return null;
  return (
    <div data-callouts className="grid gap-3 lg:grid-cols-3">
      {heldLongest ? (
        <CalloutCard
          title="Held attention longest"
          page={heldLongest.page}
          pages={pages}
          detail={`typical ${formatDwell(heldLongest.typicalMs)} · ${heldLongest.readCount} people stayed on it`}
        />
      ) : null}
      {mostPassed ? (
        <CalloutCard
          title="Most passed over"
          page={mostPassed.page}
          pages={pages}
          detail={`${mostPassed.passed} of ${mostPassed.reached} people spent under 2s on it`}
        />
      ) : null}
      {mostLeft ? (
        <CalloutCard
          title="Most people left here"
          page={mostLeft.page}
          pages={pages}
          detail={`${mostLeft.leftHere} of ${mostLeft.people} people last left from here`}
        />
      ) : null}
    </div>
  );
}
