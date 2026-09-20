/**
 * "Read" / "Skimmed" / "Started" / "Glanced" beside a reader's name.
 *
 * Whether a visit is worth opening is a judgement people were making in their heads from "9 pages ·
 * 1m 20s". This makes it, in one word, with the raw figures still on the row so the label is never
 * the only thing you can see. Nothing is shown when there is no clock — a visit recorded before
 * the reading clock existed is not a glance, it is unmeasured.
 *
 * The badge itself is not clickable. It sits inside rows that are already a link or a button, and a
 * 10px target inside a clickable row means every near-miss navigates instead — which is exactly
 * what happened when it was a button. The legend lives on the section heading instead, as a "?"
 * with room around it (`ReadingLegendButton`), and the badge keeps a plain tooltip.
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
const LEGEND: Array<{
  depth: Exclude<ReadingDepth, "unknown">;
  rule: string;
  means: string;
}> = [
  {
    depth: "read",
    rule: "15 seconds a page or more, across at least a third of it",
    means: "They went through it properly.",
  },
  {
    depth: "started",
    rule: "the same attention, but on less than a third of the pages",
    means:
      "They were reading and stopped early — usually the row worth a follow-up.",
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

function DepthChip({
  depth,
  className,
}: {
  depth: Exclude<ReadingDepth, "unknown">;
  className?: string;
}) {
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

/** The legend itself: four words, the rule behind each, and what no badge means. */
function ReadingLegendModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="How reading is judged"
      panelClassName="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-[var(--fg)]">
        How reading is judged
      </div>
      <div className="mt-1 text-[13px] leading-6 text-[var(--muted)]">
        From two facts: how long they spent per page, and how much of the
        document they reached. Deliberately coarse — a clock cannot tell a
        careful reader from a tab left open, so the words stop where the data
        does.
      </div>

      <ul className="mt-4 grid gap-3">
        {LEGEND.map((row) => (
          <li
            key={row.depth}
            className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3"
          >
            <span className="pt-0.5">
              <DepthChip depth={row.depth} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-[var(--fg)]">
                {row.means}
              </span>
              <span className="mt-0.5 block text-[12px] text-[var(--muted-2)]">
                {row.rule}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-[12px] leading-5 text-[var(--muted-2)]">
        No badge at all means no clock: visits recorded before per-page timing
        existed, and arrivals that opened nothing. A project reader is judged on
        the pages they reached through the project&rsquo;s link.
      </p>
    </Modal>
  );
}

/**
 * The "?" beside a section heading that opens the legend.
 *
 * Deliberately not on the badge: a heading has room for a real target, and nothing around it
 * navigates, so a slightly-off click costs nothing.
 */
export function ReadingLegendButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="How reading is judged"
        title="How reading is judged"
        className={[
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[10px] font-semibold text-[var(--muted-2)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]",
          className ?? "",
        ].join(" ")}
      >
        ?
      </button>
      <ReadingLegendModal open={open} onClose={() => setOpen(false)} />
    </>
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
  const depth = readingDepth({ timeMs, pages, totalPages });
  if (depth === "unknown") return null;

  return (
    <span
      title={
        depth === "read"
          ? "Went through it properly"
          : depth === "started"
            ? "Read what they opened, but stopped early"
            : depth === "skimmed"
              ? "Turned the pages quickly"
              : "Opened it and left"
      }
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
