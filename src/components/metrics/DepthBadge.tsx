/**
 * "Read" / "Skimmed" / "Started" / "Glanced" beside a reader's name.
 *
 * Whether a visit is worth opening is a judgement people were making in their heads from "9 pages ·
 * 1m 20s". This makes it, in one word, with the raw figures still on the row so the label is never
 * the only thing you can see. Nothing is shown when there is no clock — a visit recorded before
 * the reading clock existed is not a glance, it is unmeasured.
 *
 * The badge is a button, because a word that summarises someone's attention has to be able to say
 * what it means. Clicking any of them opens the same legend: the four words, the rule behind each,
 * and the two facts they are computed from.
 */
"use client";

import { useState } from "react";

import Modal from "@/components/modals/Modal";
import {
  READING_DEPTH_CLASS,
  READING_DEPTH_LABEL,
  type ReadingDepth,
  readingDepth,
} from "@/lib/metrics/readingDepth";

/** What each word means, in the order a reader meets them. */
const LEGEND: Array<{ depth: Exclude<ReadingDepth, "unknown">; rule: string; means: string }> = [
  {
    depth: "read",
    rule: "15 seconds a page or more, across at least a third of it",
    means: "They went through it properly.",
  },
  {
    depth: "started",
    rule: "the same attention, but on less than a third of the pages",
    means: "They were reading and stopped early — usually the row worth a follow-up.",
  },
  {
    depth: "skimmed",
    rule: "10 seconds or more in total, but only seconds per page",
    means: "They turned the pages quickly, looking rather than reading.",
  },
  {
    depth: "glanced",
    rule: "under 10 seconds in total",
    means: "They opened it and left.",
  },
];

function DepthChip({ depth, className }: { depth: Exclude<ReadingDepth, "unknown">; className?: string }) {
  return (
    <span
      className={[
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1",
        READING_DEPTH_CLASS[depth],
        className ?? "",
      ].join(" ")}
    >
      {READING_DEPTH_LABEL[depth]}
    </span>
  );
}

export default function DepthBadge({
  timeMs,
  pages,
  totalPages,
  className,
}: {
  timeMs: number | null | undefined;
  pages: number | null | undefined;
  /** The document's page count, so "one page of nine" is not called a read. */
  totalPages?: number | null;
  className?: string;
}) {
  const [legendOpen, setLegendOpen] = useState(false);
  const depth = readingDepth({ timeMs, pages, totalPages });
  if (depth === "unknown") return null;

  return (
    <>
      {/* A span, not a button: these sit inside rows that are already a link or a button, and a
          button inside either is invalid HTML — React says so in the console and browsers are free
          to reparent it. `role`/`tabIndex`/Enter keep it operable; the click is stopped so opening
          the legend never also follows the row. */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setLegendOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setLegendOpen(true);
        }}
        title="What these words mean"
        className={[
          "shrink-0 cursor-pointer rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1 transition-opacity hover:opacity-80",
          READING_DEPTH_CLASS[depth],
          className ?? "",
        ].join(" ")}
      >
        {READING_DEPTH_LABEL[depth]}
      </span>

      <Modal
        open={legendOpen}
        onClose={() => setLegendOpen(false)}
        ariaLabel="How reading is judged"
        panelClassName="w-[min(560px,calc(100vw-32px))]"
      >
        <div className="text-base font-semibold text-[var(--fg)]">How reading is judged</div>
        <div className="mt-1 text-[13px] leading-6 text-[var(--muted)]">
          From two facts: how long they spent per page, and how much of the document they reached. Deliberately
          coarse — a clock cannot tell a careful reader from a tab left open, so the words stop where the data
          does.
        </div>

        <ul className="mt-4 grid gap-3">
          {LEGEND.map((row) => (
            <li key={row.depth} className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <span className="pt-0.5">
                <DepthChip depth={row.depth} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] text-[var(--fg)]">{row.means}</span>
                <span className="mt-0.5 block text-[12px] text-[var(--muted-2)]">{row.rule}</span>
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[12px] leading-5 text-[var(--muted-2)]">
          No badge at all means no clock: visits recorded before per-page timing existed, and arrivals that
          opened nothing. A project reader is judged on the pages they reached through the project&rsquo;s link.
        </p>
      </Modal>
    </>
  );
}
