/**
 * Reader sheet content for one person, from a `PersonResponse`: identity, verdict, actions, key facts,
 * page-by-page bars, visits and the how-we-measure footer. Presentational only (no router or
 * context), so it renders the same in the sheet and in server-side render tests.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { PersonResponse } from "@/lib/analytics/reading/types";
import ReaderFacts from "./ReaderFacts";
import ReaderHeader, { ReaderTitleBar } from "./ReaderHeader";
import ReaderPageBars, { PageBarsKey, hasTypicalTick } from "./ReaderPageBars";
import VisitTimeline from "./VisitTimeline";

export type ReaderSheetCallbacks = {
  onClose: () => void;
  /** Filter the metrics page to this person's link. */
  onFilterLink?: (shareId: string) => void;
};

export const READER_FOOTER_TEXT =
  "How we measure: time counts while this document is on screen and someone is using it, and stops after 5 minutes without input. Pages on screen for under 2 seconds count as passed.";

const FOCUS_HIGHLIGHT_MS = 2000;

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      {aside ? (
        <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4">
          <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
          {aside}
        </div>
      ) : (
        <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
      )}
      {children}
    </section>
  );
}

/** Scrolls the page row to the middle of its nearest scrolling ancestor (the sheet panel). */
function scrollRowIntoView(row: HTMLElement) {
  let scroller: HTMLElement | null = row.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) {
    row.scrollIntoView({ block: "center" });
    return;
  }
  const rowRect = row.getBoundingClientRect();
  const boxRect = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + (rowRect.top - boxRect.top) - (boxRect.height - rowRect.height) / 2;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
}

/** The sheet body. `withTitleBar` renders the name + Close row inline (the sheet puts it in its sticky header instead). */
export default function ReaderSheetBody({
  data,
  callbacks,
  filteredShareId,
  now,
  titleId = "reader-sheet-title",
  withTitleBar = true,
  focusPage = null,
  docTitle = null,
}: {
  data: PersonResponse;
  callbacks: ReaderSheetCallbacks;
  filteredShareId: string | null;
  /** Clock for relative times ("5 min ago"). */
  now: number;
  titleId?: string;
  withTitleBar?: boolean;
  /** Page to scroll to and briefly highlight once the data is shown (e.g. from a matrix cell). */
  focusPage?: number | null;
  /** Document title, used as the follow-up email subject. */
  docTitle?: string | null;
}) {
  const { person } = data;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [highlightPage, setHighlightPage] = useState<number | null>(null);
  const focusedFor = useRef<string | null>(null);

  useEffect(() => {
    if (focusPage === null || focusPage === undefined) return;
    // Once per person + page, so a background refetch doesn't yank the scroll position back.
    const key = `${person.personId}:${focusPage}`;
    if (focusedFor.current === key) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-reader-page="${focusPage}"]`);
    if (!row) return;
    const frame = window.requestAnimationFrame(() => {
      focusedFor.current = key;
      scrollRowIntoView(row);
      setHighlightPage(focusPage);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusPage, person.personId, data]);

  useEffect(() => {
    if (highlightPage === null) return;
    const timer = window.setTimeout(() => setHighlightPage(null), FOCUS_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightPage]);

  const resolvedDocTitle = docTitle ?? (data as PersonResponse & { docTitle?: string | null }).docTitle ?? null;

  return (
    <div ref={rootRef} className="space-y-6 px-4 pb-8 pt-4 sm:px-5">
      {withTitleBar ? (
        <div className="flex items-center gap-3">
          <ReaderTitleBar titleId={titleId} name={person.name} onClose={callbacks.onClose} />
        </div>
      ) : null}

      <ReaderHeader
        person={person}
        filteredShareId={filteredShareId}
        onFilterLink={callbacks.onFilterLink}
        verdictBehaviour={data.verdict.behaviour}
        verdictPage={data.verdict.page}
        docTitle={resolvedDocTitle}
      >
        <div data-verdict className="rounded-xl bg-[var(--panel-2)] p-4 text-[15px] leading-snug text-[var(--fg)]">
          {data.verdict.text}
        </div>
      </ReaderHeader>

      <ReaderFacts data={data} now={now} />

      <Section title="Page by page" aside={hasTypicalTick(data.pages) ? <PageBarsKey pages={data.pages} /> : null}>
        <ReaderPageBars pages={data.pages} highlightPage={highlightPage} revealPage={focusPage} />
      </Section>

      {data.visits.length > 0 ? (
        <Section title="Visits">
          <VisitTimeline
            visits={data.visits}
            pageCount={data.pageCount}
            moreVisits={data.more.visits}
            typicalTotalMs={data.facts.typicalTotalMs}
          />
        </Section>
      ) : null}

      <p className="border-t border-[var(--divider)] pt-4 text-[12px] leading-relaxed text-[var(--muted)]">
        {data.multipleVersions ? `${READER_FOOTER_TEXT} Includes reads of earlier versions.` : READER_FOOTER_TEXT}
      </p>
    </div>
  );
}
