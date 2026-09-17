/**
 * Page highlights: which page held attention longest, which was skipped most, and where the most
 * people left. Shown only with enough people; otherwise the server's gate sentence is shown. Each
 * card leads with a page-number badge (page thumbnails are unreadable at this size). Counts only,
 * never percentages.
 */
"use client";

import { CALLOUT_MIN_PEOPLE } from "@/lib/analytics/reading/constants";
import { formatTypical } from "@/lib/analytics/reading/format";
import type { Callouts, PageRow } from "@/lib/analytics/reading/types";
import { tileLabelClass } from "./KpiStrip";
import { heldLongestTied, joinAnd, pageHeadline, pageShortLabel, skippedBreakdown, thinPageBeatsLeader } from "./pageEmphasis";

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

function sortedPages(page: number, tiedPages: number[] | undefined): number[] {
  return tiedPages && tiedPages.length > 1 ? [...tiedPages].sort((a, b) => a - b) : [page];
}

function peopleText(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** "Page 3", "Pages 3–5", "Pages 2, 4 and 5": consecutive runs of three or more collapse to a range. */
function pagesText(list: number[]): string {
  const sorted = [...list].sort((a, b) => a - b);
  if (sorted.length === 1) return `Page ${sorted[0]}`;
  const runs: number[][] = [];
  for (const p of sorted) {
    const run = runs[runs.length - 1];
    if (run && p === run[run.length - 1] + 1) run.push(p);
    else runs.push([p]);
  }
  const parts = runs.flatMap((r) => (r.length >= 3 ? [`${r[0]}–${r[r.length - 1]}`] : r.map(String)));
  return `Pages ${joinAnd(parts)}`;
}

const TIED_LABELS_SHOWN = 3;

function CalloutCard({
  title,
  list,
  pages,
  detail,
  note,
}: {
  title: string;
  list: number[];
  pages: PageRow[];
  detail: string;
  /** Muted aside after the detail. */
  note?: string | null;
}) {
  const first = list[0];
  const labels = list
    .map((p) => ({ p, label: pageShortLabel(pages[p - 1]) }))
    .filter((l): l is { p: number; label: string } => Boolean(l.label));
  const fullTitle = list.map((p) => pageHeadline(p, pages[p - 1])).join("; ");
  return (
    <button
      type="button"
      data-callout
      title={fullTitle}
      onClick={() => jumpToPageRow(first)}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span
        data-callout-badge
        className="flex h-10 min-w-10 shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 text-[15px] font-semibold tabular-nums text-[var(--fg)] sm:h-12 sm:min-w-12 sm:px-2.5 sm:text-[18px]"
      >
        {list.length > 1 ? `Pages ${list.join(", ")}` : `Page ${first}`}
      </span>
      <span className="min-w-0">
        <span className={`block ${tileLabelClass}`}>{title}</span>
        {list.length > 1 ? (
          labels.slice(0, TIED_LABELS_SHOWN).map(({ p, label }, i) => (
            <span key={p} className={`${i === 0 ? "mt-0.5" : ""} block truncate text-[13px] font-semibold text-[var(--fg)]`}>
              {`${p} · ${label}`}
            </span>
          ))
        ) : labels.length > 0 ? (
          <span className="mt-0.5 line-clamp-2 break-words text-[13px] font-semibold text-[var(--fg)]">{labels[0].label}</span>
        ) : null}
        <span className="block text-[12px] text-[var(--muted)]">
          {detail}
          {note ? <span className="text-[var(--muted-2)]">{` · ${note}`}</span> : null}
        </span>
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
  const { heldLongest, mostSkipped, mostLeft } = callouts;
  const heldFlat = heldLongest ? null : (callouts.heldFlat ?? null);
  if (!heldLongest && !heldFlat && !mostSkipped && !mostLeft) return null;

  let heldDetail = "";
  if (heldLongest) {
    const tied = heldLongestTied(heldLongest, pages);
    heldDetail =
      tied.length > 1
        ? `typical about ${formatTypical(heldLongest.typicalMs)} each · ${joinAnd(tied.map((t) => t.readCount))} people stayed on them`
        : `typical ${formatTypical(heldLongest.typicalMs)} · ${peopleText(heldLongest.readCount)} stayed on it`;
    if (thinPageBeatsLeader(heldLongest, pages)) heldDetail += ` · pages fewer than ${CALLOUT_MIN_PEOPLE} people stayed on aren't ranked`;
  }

  let skippedDetail = "";
  if (mostSkipped) {
    const list = sortedPages(mostSkipped.page, mostSkipped.tiedPages);
    const row = pages[mostSkipped.page - 1];
    const breakdown = row ? skippedBreakdown(row.passed, row.jumped, ", ") : null;
    skippedDetail =
      list.length > 1
        ? `${peopleText(mostSkipped.skipped)} skipped each of these`
        : `${peopleText(mostSkipped.skipped)} skipped it${breakdown ? ` (${breakdown})` : ""}`;
  }

  const leftTie = (mostLeft?.tiedPages.length ?? 0) > 1;
  // mostLeft only ranks pages before the last, so the last page's count is named beside it.
  const leftOnLast = pages[pages.length - 1]?.leftHere ?? 0;
  return (
    <div data-callouts>
      <div className="grid gap-3 lg:grid-cols-3">
        {heldLongest ? (
          <CalloutCard
            title="Held attention longest"
            list={heldLongestTied(heldLongest, pages).map((t) => t.page)}
            pages={pages}
            detail={heldDetail}
          />
        ) : heldFlat ? (
          <div data-callout data-callout-flat className="flex min-w-0 items-center rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            <span className="min-w-0">
              <span className={`block ${tileLabelClass}`}>Held attention longest</span>
              <span className="mt-0.5 block text-[13px] font-semibold text-[var(--muted)]">No single page stood out</span>
              <span className="block text-[12px] text-[var(--muted)]">
                {`${pagesText(heldFlat.pages)} each about ${formatTypical(heldFlat.typicalMs)}${
                  heldFlat.restTypicalMs !== null ? ` · other pages about ${formatTypical(heldFlat.restTypicalMs)}` : ""
                }`}
              </span>
            </span>
          </div>
        ) : null}
        {mostSkipped ? (
          <CalloutCard title="Most skipped" list={sortedPages(mostSkipped.page, mostSkipped.tiedPages)} pages={pages} detail={skippedDetail} />
        ) : null}
        {mostLeft ? (
          <CalloutCard
            title="Most people dropped off here"
            list={sortedPages(mostLeft.page, mostLeft.tiedPages)}
            pages={pages}
            detail={`${mostLeft.leftHere} of ${mostLeft.people} people left ${leftTie ? "from each of these" : "here"} before the last page`}
            note={leftOnLast > 0 ? `${leftOnLast} left on the last page` : null}
          />
        ) : null}
      </div>
    </div>
  );
}
