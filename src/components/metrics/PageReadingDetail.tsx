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
  /**
   * A one-page document, where the two clocks are the same clock.
   *
   * The page clock only moves for a page the reader has *left*, so a document with nothing to turn
   * to used to show "time per page wasn't recorded" beside a visit worth a minute and a half — on
   * the one document where the visit total *is* the page total, by definition. The clock itself
   * now reports as it goes (`readingClock`, `pageReportedMs`), which fixes it at the source; this
   * covers the rest: every reading already recorded, and the first thirty seconds of a live one,
   * before the first heartbeat lands.
   *
   * Deliberately only at one page. With two it would be a guess about which of them the time
   * belongs to, and a plausible guess printed as a measurement is worse than an honest blank.
   */
  const effectiveByPage =
    pagesSeen.length === 1 &&
    typeof totalTimeMs === "number" &&
    totalTimeMs > 0 &&
    !(msByPage[String(pagesSeen[0])] > 0)
      ? { [String(pagesSeen[0])]: totalTimeMs }
      : msByPage;

  const rows = pagesSeen
    .map((page) => ({ page, ms: effectiveByPage[String(page)] ?? 0 }))
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
      {/* One page is not a shape. The chart is a line through the pages, and with a single point
          it renders as a tall empty box around one dot — several hundred pixels that say less than
          the bar directly below them. */}
      {pagesSeen.length > 1 ? <PageTimeChart pages={pagesSeen} msByPage={effectiveByPage} /> : null}
      <ul
        className={[
          "grid gap-1.5",
          pagesSeen.length > 1 ? "mt-4 border-t border-[var(--divider)] pt-4" : "mt-3",
        ].join(" ")}
      >
        {shown.map((row) => (
          <li key={row.page} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-[12px] tabular-nums text-[var(--muted)]">Page {row.page}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-2)]">
              <span
                className="block h-full rounded-full bg-[var(--chart-views)]"
                style={{ width: `${Math.max(2, Math.round((row.ms / max) * 100))}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--fg)]">
              {row.ms > 0 ? formatDurationShort(row.ms) : "–"}
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
