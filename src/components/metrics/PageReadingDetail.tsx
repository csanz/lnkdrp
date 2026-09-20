/**
 * How one reader moved through one document: the shape, then the ranking.
 *
 * Both halves, always together, wherever this is shown — on a reader's page for a document link,
 * and inside each document they opened on a reader's page for a project. They answer different
 * questions and the second is the one people came for: the chart says they slowed down somewhere,
 * the list says on which page. Having them diverge between the two surfaces was how the project
 * side ended up with half the story.
 */
"use client";

import { PageTimeChart, formatDurationShort, formatPageRanges } from "@/components/metrics/MetricsView";

export default function PageReadingDetail({
  pagesSeen,
  msByPage,
  totalTimeMs,
  /** Cap the ranked list; the rest are summarised. Unbounded on a page that has the room. */
  limit,
}: {
  pagesSeen: number[];
  msByPage: Record<string, number>;
  totalTimeMs?: number;
  limit?: number;
}) {
  const rows = pagesSeen
    .map((page) => ({ page, ms: msByPage[String(page)] ?? 0 }))
    .sort((a, b) => b.ms - a.ms || a.page - b.page);
  const timed = rows.some((r) => r.ms > 0);
  const max = Math.max(1, ...rows.map((r) => r.ms));
  const shown = typeof limit === "number" ? rows.slice(0, limit) : rows;
  const hidden = rows.length - shown.length;

  if (!pagesSeen.length) {
    return <div className="text-[13px] text-[var(--muted)]">No page activity recorded yet.</div>;
  }

  if (!timed) {
    // Visits from before the reading clock: say which pages, and what the visit was worth.
    return (
      <div className="text-[13px] text-[var(--muted)]">
        Opened {pagesSeen.length === 1 ? "page" : "pages"} {formatPageRanges(pagesSeen)}
        {totalTimeMs && totalTimeMs > 0 ? `, ${formatDurationShort(totalTimeMs)} in total.` : "."} Time per page
        wasn&apos;t recorded for this reader.
      </div>
    );
  }

  return (
    <>
      <PageTimeChart pages={pagesSeen} msByPage={msByPage} />
      <ul className="mt-4 grid gap-1.5 border-t border-[var(--divider)] pt-4">
        {shown.map((row) => (
          <li key={row.page} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-[12px] tabular-nums text-[var(--muted)]">Page {row.page}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-2)]">
              <span
                className="block h-full rounded-full bg-emerald-500/70"
                style={{ width: `${Math.max(2, Math.round((row.ms / max) * 100))}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--fg)]">
              {row.ms > 0 ? formatDurationShort(row.ms) : "—"}
            </span>
          </li>
        ))}
        {hidden > 0 ? (
          <li className="pt-1 text-[12px] text-[var(--muted-2)]">
            and {hidden} more {hidden === 1 ? "page" : "pages"}
          </li>
        ) : null}
      </ul>
    </>
  );
}
