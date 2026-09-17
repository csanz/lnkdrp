/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 *
 * Reading data comes from `/api/docs/:docId/pages` (people, pages, links, attention); the activity
 * chart, downloads and owner-preview counts come from the lite `/shareviews` response. Range, link
 * filter and the open reader sheet live in the URL (`metricsUrlState`).
 */
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import PlanLimitNotice from "@/components/PlanLimitNotice";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import ActivityChart, { type ActivityPoint } from "@/components/metrics/ActivityChart";
import EmptyReading from "@/components/metrics/EmptyReading";
import KpiStrip from "@/components/metrics/KpiStrip";
import LinksTable from "@/components/metrics/LinksTable";
import MetricsControlBar from "@/components/metrics/MetricsControlBar";
import MetricsFootnote from "@/components/metrics/MetricsFootnote";
import NeedsAttentionCard from "@/components/metrics/NeedsAttentionCard";
import PageCallouts from "@/components/metrics/PageCallouts";
import PagePerformanceTable from "@/components/metrics/PagePerformanceTable";
import ReadingMatrix from "@/components/metrics/ReadingMatrix";
import ReaderSheet from "@/components/metrics/reader/ReaderSheet";
import { parseMetricsUrl, serializeMetricsUrl, type MetricsUrlState } from "@/components/metrics/metricsUrlState";
import { useJsonFetch } from "@/components/metrics/useJsonFetch";
import type { ReadingResponse, ReadingTier } from "@/lib/analytics/reading/types";
import { usePlan } from "@/lib/client/usePlan";
import { subscribeRealtime } from "@/lib/client/realtime";

/** The fields this page reads from the lite `/shareviews` response. */
type ActivityResponse = {
  ok: true;
  docTitle?: string;
  days: number;
  downloadsEnabled?: boolean;
  totals: { downloads?: number; ownerPreviews?: number };
  totalsAllTime?: { ownerPreviews?: number };
  series?: ActivityPoint[];
};

const REFRESH_DEBOUNCE_MS = 3000;
const cardClass = "rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5";
const sectionTitleClass = "text-sm font-semibold text-[var(--fg)]";

const noopSubscribe = () => () => {};

/** False while hydrating (matches the server render), true on every client render after that. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function Skeleton({ height }: { height: number }) {
  return <div className="animate-pulse rounded-2xl bg-[var(--panel-hover)]" style={{ height }} />;
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--muted)]">
      {"Couldn't load page data."}
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Keeps the last response for a scope so a background refresh (realtime, tab focus, "show all")
 * does not flash skeletons; a new range or link starts from skeletons instead of old numbers.
 */
function useScopedData<T>(data: T | null, scopeKey: string): T | null {
  const [kept, setKept] = useState<{ key: string; data: T } | null>(null);
  useEffect(() => {
    if (data) setKept({ key: scopeKey, data });
  }, [data, scopeKey]);
  return data ?? (kept && kept.key === scopeKey ? kept.data : null);
}

/** Render the metrics page. */
export default function MetricsPageClient({ docId }: { docId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { plan } = usePlan();
  const { openUpgrade } = useUpgradeModal();
  const hydrated = useHydrated();

  // The response's tier wins; the plan snapshot only decides the first request's default range.
  // The snapshot is ignored while hydrating: the server has no plan, and a cached one would change the range options.
  const [serverTier, setServerTier] = useState<ReadingTier | null>(null);
  const planTier: ReadingTier | null = hydrated && plan ? (plan.plan === "free" ? "basic" : "deep") : null;
  const tier: ReadingTier | null = serverTier ?? planTier;
  const { shareId, days, personId } = parseMetricsUrl(searchParams, tier);
  const [matrixAll, setMatrixAll] = useState(false);

  const enc = encodeURIComponent(docId);
  const scopeQs = shareId ? `&shareId=${encodeURIComponent(shareId)}` : "";
  const scopeKey = `${days}|${shareId ?? ""}`;
  const a = useJsonFetch<ReadingResponse>(
    hydrated ? `/api/docs/${enc}/pages?days=${days}${scopeQs}${matrixAll ? "&matrix=all" : ""}` : null,
  );
  const b = useJsonFetch<ActivityResponse>(hydrated ? `/api/docs/${enc}/shareviews?days=${days}&lite=1${scopeQs}` : null);
  const reading = useScopedData(a.data, scopeKey);
  const activity = useScopedData(b.data, scopeKey);
  const readingError = !reading && a.error !== null && a.status !== 404;
  const activityError = !activity && b.error !== null && b.status !== 404;

  useEffect(() => {
    if (a.data?.tier) setServerTier(a.data.tier);
  }, [a.data?.tier]);

  const writeUrl = useCallback(
    (next: Partial<MetricsUrlState>) => {
      const state: MetricsUrlState = { shareId, days, personId, ...next };
      router.replace(`${pathname}${serializeMetricsUrl(state, tier)}`, { scroll: false });
    },
    [router, pathname, shareId, days, personId, tier],
  );

  useEffect(() => {
    if (a.status !== 404 && b.status !== 404) return;
    // A link filter that no longer resolves falls back to the whole document; a missing document leaves.
    if (shareId) writeUrl({ shareId: null, personId: null });
    else router.replace("/dashboard");
  }, [a.status, b.status, shareId, writeUrl, router]);

  const { retry: retryA } = a;
  const { retry: retryB } = b;
  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => {
      retryA();
      retryB();
    };
    const unsubscribe = subscribeRealtime("activity", (frame) => {
      if (frame.type !== "activity") return;
      const type = frame.event.type ?? "";
      if (!type.startsWith("share.") && !type.startsWith("share_link.")) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [retryA, retryB]);

  const closePerson = useCallback(() => writeUrl({ personId: null }), [writeUrl]);
  const openPerson = useCallback((id: string) => writeUrl({ personId: id }), [writeUrl]);
  const filterLink = useCallback(
    (id: string | null) => {
      setMatrixAll(false);
      writeUrl({ shareId: id, personId: null });
    },
    [writeUrl],
  );

  const now = reading ? Date.parse(reading.generatedAt) : 0;
  const deep = reading?.tier === "deep";
  const docTitle = activity?.docTitle?.trim() || "";
  const selectedLinkLabel = shareId ? (reading?.links.find((l) => l.shareId === shareId)?.label ?? "Link") : null;
  const downloads =
    activity && (activity.downloadsEnabled || (activity.totals.downloads ?? 0) > 0) ? (activity.totals.downloads ?? 0) : null;
  const seed = personId ? (reading?.matrix?.rows.find((r) => r.personId === personId) ?? null) : null;

  let readingBody: React.ReactNode;
  if (readingError) {
    readingBody = (
      <div className={cardClass}>
        <LoadError onRetry={retryA} />
      </div>
    );
  } else if (!reading) {
    readingBody = (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" aria-busy="true">
        <Skeleton height={240} />
        <Skeleton height={200} />
      </div>
    );
  } else {
    const pages = reading.pages ?? [];
    const pageCount = reading.pageCount ?? pages.length;
    const withDetail = reading.peopleWithDetail ?? 0;
    readingBody = (
      <>
        {reading.people === 0 ? (
          <EmptyReading
            docId={docId}
            days={reading.days}
            everOpened={reading.everOpened}
            lastOpenedAtAllTime={reading.lastOpenedAtAllTime}
            links={reading.links}
            shareId={shareId}
            ownerPreviewsAllTime={activity?.totalsAllTime?.ownerPreviews ?? null}
            now={now}
          />
        ) : null}
        {reading.tier === "basic" ? <PlanLimitNotice limit="analytics_history" /> : null}
        {deep && reading.people > 0 ? (
          <div className={cardClass}>
            <h2 className={sectionTitleClass}>How far each person got</h2>
            {withDetail === 0 ? (
              <p className="mt-2 text-[13px] text-[var(--muted)]">
                {"Page detail wasn't recorded for these people. They opened it before page tracking."}
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-5">
                <ReadingMatrix
                  rows={reading.matrix?.rows ?? []}
                  total={reading.matrix?.total ?? 0}
                  limit={reading.matrix?.limit ?? 0}
                  pages={pages}
                  pageCount={pageCount}
                  peopleWithDetail={withDetail}
                  now={now}
                  onOpenPerson={(row) => openPerson(row.personId)}
                  onShowAll={() => setMatrixAll(true)}
                  loadingAll={matrixAll && a.loading}
                />
                <PageCallouts callouts={reading.callouts ?? null} calloutGate={reading.calloutGate ?? null} pages={pages} />
                <PagePerformanceTable pages={pages} pageCount={pageCount} peopleWithDetail={withDetail} />
              </div>
            )}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-4 sm:px-6">
        <Link
          href={shareId ? `/doc/${enc}/links` : `/doc/${enc}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label={shareId ? "Back to links" : "Back to document"}
          title={shareId ? "Back to links" : "Back to document"}
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{docTitle || "Document"}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Link href={`/doc/${enc}`} className="underline-offset-4 hover:underline">
              Document
            </Link>
            <span aria-hidden="true">›</span>
            {selectedLinkLabel ? (
              <>
                <Link href={`/doc/${enc}/links`} className="underline-offset-4 hover:underline">
                  Links
                </Link>
                <span aria-hidden="true">›</span>
                <span className="max-w-[240px] truncate font-medium text-[var(--fg)]">{selectedLinkLabel}</span>
              </>
            ) : (
              <span className="font-medium text-[var(--fg)]">Metrics</span>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-6 pt-2 sm:px-6">
          <MetricsControlBar
            links={reading?.links ?? null}
            shareId={shareId}
            days={days}
            tier={reading?.tier ?? tier}
            onShareId={filterLink}
            onDays={(d) => {
              setMatrixAll(false);
              writeUrl({ days: d });
            }}
            onMoreHistory={() => openUpgrade("analytics_history")}
          />

          {reading && reading.people > 0 ? (
            <NeedsAttentionCard rows={reading.attention.rows} more={reading.attention.more} now={now} onOpenPerson={openPerson} />
          ) : null}

          <KpiStrip reading={reading} loading={!reading && !readingError} error={readingError} downloads={downloads} now={now} />

          <section id="reading" className="grid scroll-mt-16 grid-cols-[minmax(0,1fr)] gap-4">
            {readingBody}
          </section>

          <section id="links" className={cardClass}>
            <h2 className={sectionTitleClass}>Links</h2>
            <div className="mt-3">
              {readingError ? (
                <LoadError onRetry={retryA} />
              ) : reading ? (
                <LinksTable
                  docId={docId}
                  links={reading.links}
                  tier={reading.tier}
                  selectedShareId={shareId}
                  now={now}
                  onSelect={(id) => filterLink(id === shareId ? null : id)}
                />
              ) : (
                <Skeleton height={160} />
              )}
            </div>
          </section>

          <ActivityChart
            series={activity?.series ?? null}
            loading={!activity && !activityError}
            error={activityError}
            onRetry={retryB}
          />

          <MetricsFootnote
            deep={deep}
            people={reading?.people ?? null}
            peopleWithDetail={reading?.peopleWithDetail ?? null}
            multipleVersions={Boolean(reading?.multipleVersions)}
            truncated={Boolean(reading?.coverage?.truncated)}
            ownerPreviews={activity ? (activity.totals.ownerPreviews ?? 0) : null}
          />
        </div>
      </div>

      <ReaderSheet
        docId={docId}
        personId={personId}
        days={days}
        seed={seed}
        filteredShareId={shareId}
        onClose={closePerson}
        onFilterLink={filterLink}
      />
    </div>
  );
}
