/**
 * Reader sheet content for one person, from a `PersonResponse`: identity, verdict, key facts,
 * page-by-page bars, visits and the how-we-measure footer. Presentational only (no router or
 * context), so it renders the same in the sheet and in server-side render tests.
 */
"use client";

import type { PersonResponse } from "@/lib/analytics/reading/types";
import ReaderFacts from "./ReaderFacts";
import ReaderHeader, { ReaderTitleBar } from "./ReaderHeader";
import ReaderPageBars from "./ReaderPageBars";
import VisitTimeline from "./VisitTimeline";

export type ReaderSheetCallbacks = {
  onClose: () => void;
  /** Filter the metrics page to this person's link. */
  onFilterLink?: (shareId: string) => void;
};

export const READER_FOOTER_TEXT =
  "How we measure: time counts while this document is on screen and someone is using it, and stops after 5 minutes without input. Pages on screen for under 2 seconds count as passed.";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
      {children}
    </section>
  );
}

/** The sheet body. `withTitleBar` renders the name + Close row inline (the sheet puts it in its sticky header instead). */
export default function ReaderSheetBody({
  data,
  callbacks,
  filteredShareId,
  now,
  titleId = "reader-sheet-title",
  withTitleBar = true,
}: {
  data: PersonResponse;
  callbacks: ReaderSheetCallbacks;
  filteredShareId: string | null;
  /** Clock for relative times ("5 min ago"). */
  now: number;
  titleId?: string;
  withTitleBar?: boolean;
}) {
  const { person } = data;
  return (
    <div className="space-y-6 px-4 pb-8 pt-4 sm:px-5">
      {withTitleBar ? (
        <div className="flex items-center gap-3">
          <ReaderTitleBar titleId={titleId} name={person.name} onClose={callbacks.onClose} />
        </div>
      ) : null}

      <ReaderHeader person={person} filteredShareId={filteredShareId} onFilterLink={callbacks.onFilterLink} />

      <div data-verdict className="rounded-xl bg-[var(--panel-2)] p-4 text-[15px] leading-snug text-[var(--fg)]">
        {data.verdict.text}
      </div>

      <ReaderFacts data={data} now={now} />

      <Section title="Page by page">
        <ReaderPageBars pages={data.pages} />
      </Section>

      {data.visits.length > 0 ? (
        <Section title="Visits">
          <VisitTimeline visits={data.visits} pageCount={data.pageCount} moreVisits={data.more.visits} />
        </Section>
      ) : null}

      <p className="border-t border-[var(--divider)] pt-4 text-[12px] leading-relaxed text-[var(--muted)]">
        {data.multipleVersions ? `${READER_FOOTER_TEXT} Includes reads of earlier versions.` : READER_FOOTER_TEXT}
      </p>
    </div>
  );
}
