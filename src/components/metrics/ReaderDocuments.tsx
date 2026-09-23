/**
 * "Documents they opened" — the room half of a reader's page.
 *
 * A project link writes one row per (viewer, document), so this list is the shape of one person's
 * visit to a data room: which files they opened, how long each held them, and — one click down —
 * which pages of each. The drill-down is deliberately not a link to the document's own metrics: a
 * read through a project link belongs to the project (`docScope.ts`), so that person may not be in
 * the document's own viewer list at all, and sending someone there would show them an empty page
 * and call it the truth.
 *
 * It owns no state. Which panel is open, and whether it opened itself because the reader walked
 * into that document, are decisions `ViewerProfile` makes — it is the one holding the live
 * position and the loaders. This renders them.
 */
"use client";

import Link from "next/link";
import { DocumentTextIcon } from "@heroicons/react/24/outline";

import { formatDurationShort } from "@/components/metrics/MetricsView";
import PageReadingDetail from "@/components/metrics/PageReadingDetail";

/** One document's pages, or the marker for a fetch still in flight. */
export type DocDetail =
  | { pagesSeen: number[]; pageTimeMsByPage: Record<string, number>; timeSpentMs: number; sessions: number }
  | "loading";

export type ReaderDoc = { docId: string; title: string | null; timeSpentMs: number };

export default function ReaderDocuments({
  docs,
  openedNothing,
  openDocId,
  detailByDocId,
  live,
  onToggle,
}: {
  docs: ReaderDoc[];
  /** They arrived in the room and opened nothing — different from having no data yet. */
  openedNothing?: boolean;
  openDocId: string | null;
  detailByDocId: Record<string, DocDetail>;
  /** The document they have open this second, and where in it. Null when nobody is reading. */
  live: { docId: string | null; page: number | null; of: number | null } | null;
  onToggle: (docId: string) => void;
}) {
  if (!docs.length) {
    return (
      <div className="mt-2 text-[13px] text-[var(--muted)]">
        {openedNothing ? "They arrived and opened nothing." : "No documents opened yet."}
      </div>
    );
  }

  // The longest read sets the scale, so the bars compare documents to each other rather than to a
  // number nobody on this page can see.
  const max = Math.max(1, ...docs.map((d) => d.timeSpentMs));

  return (
    <ul className="mt-3 grid gap-1.5">
      {docs.map((d) => {
        const detail = detailByDocId[d.docId];
        const expanded = openDocId === d.docId;
        // The one they are in right now. A room's list is otherwise a ranking by time, and the
        // document someone has open this second is the only row on this page that is news rather
        // than history.
        const isLive = live?.docId === d.docId;
        return (
          <li
            key={d.docId}
            data-open={expanded}
            className={[
              "rounded-xl border transition-colors data-[open=true]:bg-[var(--panel-2)]",
              isLive
                ? "border-emerald-600/40 bg-emerald-500/5 dark:border-emerald-300/40"
                : "border-transparent data-[open=true]:border-[var(--border)]",
            ].join(" ")}
          >
            <button
              type="button"
              onClick={() => onToggle(d.docId)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--panel-hover)]"
              title="See which pages they read in this document"
            >
              <DocumentTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]">{d.title || "Untitled document"}</span>
              {isLive ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-700 dark:border-emerald-300/40 dark:text-emerald-300"
                  title="They have this open right now"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse dark:bg-emerald-400" />
                  {live?.page ? `Page ${live.page}${live.of ? `/${live.of}` : ""}` : "Open now"}
                </span>
              ) : null}
              {/* The bar is a comparison between rows, not a number anyone reads off it — so on a
                  phone it is the first thing to go. With it, the 96px bar plus the 64px time
                  column plus the live chip left the document's name no width at all, and the name
                  is what the row is for. `hidden sm:block` rather than a narrower bar: half a bar
                  compares worse than no bar. */}
              <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--panel-2)] sm:block">
                <span
                  className="block h-full rounded-full bg-[var(--chart-views)]"
                  style={{ width: `${Math.max(2, Math.round((d.timeSpentMs / max) * 100))}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--muted)]">
                {d.timeSpentMs > 0 ? formatDurationShort(d.timeSpentMs) : "—"}
              </span>
            </button>

            {/* Opened and closed on a grid row rather than a height, because nothing here knows how
                tall a chart plus nine page rows is — `0fr → 1fr` animates to the content's own
                height. The panel stays mounted once it has been opened so the close animates too,
                and `inert` keeps its link out of the tab order while it is shut. `motion-reduce`
                turns the whole thing into a cut. */}
            {expanded || detail ? (
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
                style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden" inert={!expanded}>
                  <div className="border-t border-[var(--divider)] px-3 pb-3 pt-2.5">
                    {detail === "loading" || !detail ? (
                      <div className="text-[12px] text-[var(--muted)]">Loading pages…</div>
                    ) : detail.pagesSeen.length ? (
                      <>
                        <div className="text-[12px] text-[var(--muted-2)]">
                          {detail.sessions > 0 ? `${detail.sessions} ${detail.sessions === 1 ? "session" : "sessions"} · ` : ""}
                          {detail.pagesSeen.length} {detail.pagesSeen.length === 1 ? "page" : "pages"}
                          {detail.timeSpentMs > 0 ? ` · ${formatDurationShort(detail.timeSpentMs)}` : ""}
                        </div>
                        {/* The same component the document side uses: chart and ranked pages, never
                            one without the other. */}
                        <div className="mt-2">
                          <PageReadingDetail
                            pagesSeen={detail.pagesSeen}
                            msByPage={detail.pageTimeMsByPage}
                            totalTimeMs={detail.timeSpentMs}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="text-[12px] text-[var(--muted)]">No pages recorded for this document.</div>
                    )}
                    <div className="mt-2">
                      <Link
                        href={`/doc/${encodeURIComponent(d.docId)}/metrics`}
                        className="text-[12px] font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
                      >
                        This document&apos;s own metrics →
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
