"use client";

/**
 * The headline figures on `/metrics` — views, opens, reading time, downloads — each with its change
 * against the previous period, and the "12 of 104 shared documents were opened" sentence under them.
 *
 * The tiles are the chart's control: one is always pressed and the hero chart shows that series, so
 * they are buttons with `aria-pressed` rather than cards that happen to be clickable.
 *
 * Usually four, sometimes three: Opens is withheld on a window whose visit rows are incomplete
 * (`opensPartial`), exactly as the document page withholds it, so the grid is told how many tiles it
 * has rather than assuming.
 */
import { cn } from "@/lib/cn";
import type { WorkspaceHeadline } from "@/lib/analytics/workspace/types";
import {
  METRIC_META,
  changeChip,
  formatMetricValue,
  openedSentence,
  visibleMetricKeys,
  type ChangeTone,
  type MetricKey,
} from "./format";

/** Up is emerald, down is muted grey. A quiet week is information, not an error, so never red. */
const TONE_CLASS: Record<ChangeTone, string> = {
  up: "bg-[var(--panel-hover)] text-[var(--chart-views)]",
  down: "bg-[var(--panel-hover)] text-[var(--muted-2)]",
  flat: "bg-[var(--panel-hover)] text-[var(--muted-2)]",
  new: "bg-[var(--panel-hover)] text-[var(--chart-views)]",
  none: "bg-[var(--panel-hover)] text-[var(--muted-2)]",
};

const TONE_ARROW: Record<ChangeTone, string> = { up: "↑", down: "↓", flat: "", new: "", none: "" };

/** The selectable headline tiles plus the documents-opened sentence. */
export default function HeadlineStrip({
  headline,
  selected,
  onSelect,
  previousDays,
  docsOpened,
  opensPartial,
}: {
  headline: WorkspaceHeadline;
  selected: MetricKey;
  onSelect: (key: MetricKey) => void;
  /** Length of the comparison window; 0 when none was served (Free), which hides every chip. */
  previousDays: number;
  docsOpened: { opened: number; shared: number; openedOther: number; returningReaders: number | null };
  /** True when `opens` is a floor rather than a count, which drops its tile. */
  opensPartial: boolean;
}) {
  const keys = visibleMetricKeys(opensPartial);
  return (
    <section aria-label="Headline figures">
      <div className={cn("grid grid-cols-2 gap-3", keys.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4")}>
        {keys.map((key) => {
          const meta = METRIC_META[key];
          const delta = headline[key];
          const chip = previousDays > 0 ? changeChip(delta, previousDays, meta.label) : null;
          const active = key === selected;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(key)}
              title={chip?.title ?? `Show ${meta.label.toLowerCase()} per day`}
              className={cn(
                "min-w-0 rounded-2xl border p-4 text-left shadow-[var(--shadow-card)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                // A card, not an inset: white like every other top-level card on the page, and
                // selected by its edge rather than by a fill — a darker fill reads as pressed or
                // disabled, which is the opposite of chosen.
                //
                // That edge used to be `--fg`, a near-black border *and* ring, which came out as a
                // ~2px black rectangle beside three 1.27:1 hairlines: the harshest thing on the
                // page, and it read as an error rather than a selection. It was that heavy because
                // light had no ground to lift a card off — `--bg` and `--panel` were the same
                // white, so weight was the only signal available. Now that the page sits below the
                // card, the chosen tile can say so quietly: it takes the chart's own colour, which
                // is the honest cue — this tile is the series the graph below is drawing. The lift
                // is on the base class, because every card on this page is a card; using elevation
                // to mark selection made the other three look like they had not finished loading.
                active
                  ? "border-[var(--chart-views)] bg-[var(--panel)]"
                  : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]",
              )}
            >
              <div className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">{meta.label}</div>
              <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-[var(--fg)]">
                {formatMetricValue(key, delta.value)}
              </div>
              {/* Reserved whether or not a chip is shown, so switching range or plan never nudges the chart down. */}
              <div className="mt-1.5 flex min-h-[18px] flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {chip ? (
                  <>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", TONE_CLASS[chip.tone])}>
                      {TONE_ARROW[chip.tone] ? `${TONE_ARROW[chip.tone]} ` : ""}
                      {chip.label}
                    </span>
                    <span className="truncate text-[10px] text-[var(--muted-2)]">{chip.caption}</span>
                  </>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 px-1 text-[12px] text-[var(--muted-2)]">{openedSentence(docsOpened)}</p>
    </section>
  );
}
