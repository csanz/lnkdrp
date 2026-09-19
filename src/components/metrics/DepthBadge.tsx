/**
 * "Read" / "Skimmed" / "Glanced" beside a reader's name.
 *
 * Whether a visit is worth opening is a judgement people were making in their heads from "9 pages ·
 * 1m 20s". This makes it, in one word, with the raw figures in the tooltip so the label is never
 * the only thing you can see. Nothing is shown when there is no clock — a visit recorded before
 * the reading clock existed is not a glance, it is unmeasured.
 */
"use client";

import { READING_DEPTH_CLASS, READING_DEPTH_LABEL, readingDepth } from "@/lib/metrics/readingDepth";

export default function DepthBadge({
  timeMs,
  pages,
  className,
}: {
  timeMs: number | null | undefined;
  pages: number | null | undefined;
  className?: string;
}) {
  const depth = readingDepth({ timeMs, pages });
  if (depth === "unknown") return null;
  return (
    <span
      className={[
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1",
        READING_DEPTH_CLASS[depth],
        className ?? "",
      ].join(" ")}
      title={
        depth === "read"
          ? "Spent real time on it"
          : depth === "skimmed"
            ? "Moved through it quickly"
            : "Opened it and left"
      }
    >
      {READING_DEPTH_LABEL[depth]}
    </span>
  );
}
