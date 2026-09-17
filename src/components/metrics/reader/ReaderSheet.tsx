/**
 * ReaderSheet — loads one person's reading detail and shows it in a Sheet. While loading it shows
 * the matrix row it was opened from (name, link, chip) above skeletons; a 402 opens the upgrade
 * modal and closes the sheet.
 */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import Sheet from "@/components/ui/Sheet";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import type { MatrixRow, PersonResponse } from "@/lib/analytics/reading/types";
import { useJsonFetch } from "../useJsonFetch";
import ReaderHeader, { ReaderTitleBar } from "./ReaderHeader";
import ReaderSheetBody from "./ReaderSheetBody";

export type ReaderSheetProps = {
  docId: string;
  /** Person to show; null keeps the sheet closed. */
  personId: string | null;
  days: number;
  /** Matrix row the sheet was opened from, used for the header while loading. */
  seed?: MatrixRow | null;
  filteredShareId: string | null;
  onClose: () => void;
  onFilterLink: (shareId: string) => void;
};

function Skeleton({ height }: { height: number }) {
  return <div className="animate-pulse rounded-xl bg-[var(--panel-hover)]" style={{ height }} />;
}

/** Person reading detail sheet for the metrics page. */
export default function ReaderSheet({ docId, personId, days, seed, filteredShareId, onClose, onFilterLink }: ReaderSheetProps) {
  const titleId = useId();
  const { openUpgrade } = useUpgradeModal();
  const url = personId
    ? `/api/docs/${encodeURIComponent(docId)}/pages/person?id=${encodeURIComponent(personId)}&days=${days}`
    : null;
  const { data, error, status, loading, retry } = useJsonFetch<PersonResponse>(url);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (data) setNow(Date.now());
  }, [data]);

  // Once per request url, even if the parent passes a new onClose on every render.
  const upgradedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 402 || !url || upgradedFor.current === url) return;
    upgradedFor.current = url;
    openUpgrade("analytics_history");
    onClose();
  }, [status, url, openUpgrade, onClose]);

  const matchingSeed = seed && seed.personId === personId ? seed : null;
  const name = data?.person.name ?? matchingSeed?.name ?? null;
  const pageCount = data?.pageCount ?? matchingSeed?.cells.length ?? 4;
  const showSkeleton = !data && (loading || status === 402);

  let body: React.ReactNode;
  if (data) {
    body = (
      <ReaderSheetBody
        data={data}
        callbacks={{ onClose, onFilterLink }}
        filteredShareId={filteredShareId}
        now={now || Date.parse(data.person.lastSeen)}
        titleId={titleId}
        withTitleBar={false}
      />
    );
  } else if (showSkeleton) {
    body = (
      <div className="space-y-6 px-4 pb-8 pt-4 sm:px-5" aria-busy="true">
        {matchingSeed ? (
          <ReaderHeader person={matchingSeed} filteredShareId={filteredShareId} actions={false} />
        ) : (
          <Skeleton height={20} />
        )}
        <Skeleton height={48} />
        <Skeleton height={72} />
        <div className="space-y-2">
          {Array.from({ length: Math.max(1, Math.min(pageCount, 12)) }, (_, i) => (
            <Skeleton key={i} height={44} />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      </div>
    );
  } else if (status === 404) {
    body = (
      <div className="px-4 py-10 text-center text-sm text-[var(--muted)] sm:px-5">
        This person wasn&apos;t active in the selected range.
      </div>
    );
  } else if (error !== null || status !== null) {
    body = (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-5">
        <p className="text-sm text-[var(--muted)]">Couldn&apos;t load this person&apos;s activity.</p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          Try again
        </button>
      </div>
    );
  } else {
    body = null;
  }

  return (
    <Sheet
      open={personId !== null}
      onClose={onClose}
      labelledBy={titleId}
      busy={showSkeleton}
      dataAttributes={{ "data-reader-sheet": "" }}
      header={<ReaderTitleBar titleId={titleId} name={name} onClose={onClose} />}
    >
      {body}
    </Sheet>
  );
}
