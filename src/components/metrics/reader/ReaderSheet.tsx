/**
 * ReaderSheet — loads one person's reading detail and shows it in a Sheet. While loading it shows
 * the matrix row it was opened from (name, link, chip) above skeletons; a 402 opens the upgrade
 * modal and closes the sheet; a 404 names the person and offers a wider range.
 */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import Sheet from "@/components/ui/Sheet";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { ALLOWED_DAYS } from "@/lib/analytics/reading/constants";
import { formatRelative, rangeLabel } from "@/lib/analytics/reading/format";
import type { MatrixRow, PersonResponse } from "@/lib/analytics/reading/types";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
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
  /** Widen the date range while keeping this person open (offered when they weren't active in range). */
  onChangeDays?: (days: AllowedDays) => void;
  /** Page row to scroll to and highlight once loaded. */
  focusPage?: number | null;
  /** Document title, used as the follow-up email subject. */
  docTitle?: string | null;
  /** Bump to refetch the open person in place (e.g. on a realtime event); the current data stays shown meanwhile. */
  refreshKey?: number;
};

type AllowedDays = (typeof ALLOWED_DAYS)[number];
type NotFoundPerson = { name: string; lastSeen: string | null };

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The next wider range after `days`, or null at the widest. */
export function nextWiderDays(days: number): AllowedDays | null {
  return ALLOWED_DAYS.find((d) => d > days) ?? null;
}

/** The 404 body names the person when they exist outside the range: `{ error, person: { name, lastSeen } | null }`. */
function parseNotFoundPerson(body: unknown): NotFoundPerson | null {
  const person = body && typeof body === "object" ? (body as { person?: unknown }).person : null;
  if (!person || typeof person !== "object") return null;
  const { name, lastSeen } = person as { name?: unknown; lastSeen?: unknown };
  if (typeof name !== "string" || !name) return null;
  return { name, lastSeen: typeof lastSeen === "string" ? lastSeen : null };
}

/** useJsonFetch drops error bodies, so the 404 body is read once more for the person's name. */
function useNotFoundPerson(url: string | null, status: number | null): NotFoundPerson | null {
  const [found, setFound] = useState<{ url: string; person: NotFoundPerson | null } | null>(null);
  useEffect(() => {
    if (status !== 404 || !url) return;
    const controller = new AbortController();
    void fetchWithTempUser(url, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((body: unknown) => {
        if (!controller.signal.aborted) setFound({ url, person: parseNotFoundPerson(body) });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url, status]);
  return found && found.url === url && status === 404 ? found.person : null;
}

function Skeleton({ height }: { height: number }) {
  return <div className="animate-pulse rounded-xl bg-[var(--panel-hover)]" style={{ height }} />;
}

/** Person reading detail sheet for the metrics page. */
export default function ReaderSheet({
  docId,
  personId,
  days,
  seed,
  filteredShareId,
  onClose,
  onFilterLink,
  onChangeDays,
  focusPage = null,
  docTitle = null,
  refreshKey,
}: ReaderSheetProps) {
  const titleId = useId();
  const { openUpgrade } = useUpgradeModal();
  const url = personId
    ? `/api/docs/${encodeURIComponent(docId)}/pages/person?id=${encodeURIComponent(personId)}&days=${days}&tz=${encodeURIComponent(browserTimeZone())}`
    : null;
  const { data: fetched, error, status, loading, retry } = useJsonFetch<PersonResponse>(url);
  const notFoundPerson = useNotFoundPerson(url, status);
  const [now, setNow] = useState(0);

  // A refresh keeps showing the last data for the same url until the new response lands, so the
  // sheet doesn't flash skeletons; another person or range never borrows it.
  const [lastGood, setLastGood] = useState<{ url: string; data: PersonResponse } | null>(null);
  if (fetched && url && (lastGood?.data !== fetched || lastGood.url !== url)) setLastGood({ url, data: fetched });
  const data = fetched ?? (loading && lastGood && lastGood.url === url ? lastGood.data : null);

  useEffect(() => {
    if (fetched || status === 404) setNow(Date.now());
  }, [fetched, status]);

  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    if (url) retry();
  }, [refreshKey, url, retry]);

  // Once per request url, even if the parent passes a new onClose on every render.
  const upgradedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 402 || !url || upgradedFor.current === url) return;
    upgradedFor.current = url;
    openUpgrade("analytics_history");
    onClose();
  }, [status, url, openUpgrade, onClose]);

  const matchingSeed = seed && seed.personId === personId ? seed : null;
  const name =
    data?.person.name ??
    matchingSeed?.name ??
    (status === 404 ? (notFoundPerson?.name ?? "Reader") : null);
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
        focusPage={focusPage}
        docTitle={docTitle}
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
    const wider = onChangeDays ? nextWiderDays(days) : null;
    const lastSeen = notFoundPerson?.lastSeen && now ? formatRelative(notFoundPerson.lastSeen, now) : null;
    body = (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center sm:px-5" data-reader-not-in-range>
        <p className="text-sm text-[var(--fg)]">{`This person wasn't active in the last ${rangeLabel(days)}.`}</p>
        {lastSeen ? <p className="text-[13px] text-[var(--muted)]">{`Last opened ${lastSeen}`}</p> : null}
        {wider !== null && onChangeDays ? (
          <button
            type="button"
            onClick={() => onChangeDays(wider)}
            className="mt-2 inline-flex h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-9"
          >
            {`Show last ${rangeLabel(wider)}`}
          </button>
        ) : null}
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
