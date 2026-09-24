"use client";

/**
 * Client UI for `/metrics` — how the whole workspace's sharing is doing.
 *
 * One request drives the page (`GET /api/metrics/workspace?range=`), so there is one loading state,
 * one error state and no half-filled screen. Three behaviours worth knowing before editing:
 *
 * - **The range is remembered per browser, not in the URL.** No `useSearchParams`, so this page
 *   needs no `<Suspense>` boundary and a range change never re-runs the route segment.
 * - **Free is clamped by the server, not by this file.** The control locks 30d/90d behind the
 *   upgrade modal, but the served window is always `data.range` — the page labels what it got.
 * - **Realtime is a nudge, not a stream.** A recipient's open arrives as a `share.*` activity frame;
 *   the page coalesces a burst into one `?fresh=1` refetch a couple of seconds later, and skips it
 *   while the tab is hidden. There is no polling fallback: the numbers are a summary, not a feed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartBarSquareIcon } from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import Alert from "@/components/ui/Alert";
import HeadlineStrip from "@/components/workspaceMetrics/HeadlineStrip";
import HeroChart from "@/components/workspaceMetrics/HeroChart";
import MetricsSkeleton, { MetricsEmptyWorkspace } from "@/components/workspaceMetrics/MetricsSkeleton";
import { useSkeletonDelay } from "@/lib/client/useSkeletonDelay";
import { readPageCache, writePageCache } from "@/lib/client/pageCache";
import RangeControl from "@/components/workspaceMetrics/RangeControl";
import {
  ContributorsSection,
  PeopleSection,
  QuietDocsSection,
  TopDocsSection,
  TopLinksSection,
} from "@/components/workspaceMetrics/Sections";
import { outputSentence, type MetricKey } from "@/components/workspaceMetrics/format";
// The same duration wording the document and project cards print, so "58s" means 58s everywhere.
import { formatDurationShort } from "@/components/metrics/MetricsView";
// `./types` and not the barrel: the barrel re-exports `./range`, which reaches the plan limits
// and through them Mongoose. `types.ts` imports nothing, so nothing server-only follows it here.
import {
  WORKSPACE_DEFAULT_RANGE,
  WORKSPACE_RANGE_KEYS,
  type WorkspaceMetricsResponse,
  type WorkspaceRangeKey,
} from "@/lib/analytics/workspace/types";
import { REALTIME_STATE_EVENT, realtimeState, subscribeRealtime } from "@/lib/client/realtime";
import { usePlan } from "@/lib/client/usePlan";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import RecentVisitors from "@/components/metrics/RecentVisitors";

/** Where the chosen range is remembered. Per browser, like the dashboard's usage range. */
const RANGE_STORAGE_KEY = "lnkdrp:metrics:range";
/**
 * How long a burst of activity frames is allowed to settle before one refetch. Longer than the
 * feed's 600ms on purpose: the endpoint caches for 60s, and a summary that lags a reader by two
 * seconds is still live enough.
 */
const REFETCH_DEBOUNCE_MS = 2000;

/** The remembered range, or `null` when nothing valid is stored (or storage is blocked). */
function readStoredRange(): WorkspaceRangeKey | null {
  try {
    const raw = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return WORKSPACE_RANGE_KEYS.includes(raw as WorkspaceRangeKey) ? (raw as WorkspaceRangeKey) : null;
  } catch {
    return null;
  }
}

/** Remember the chosen range for next time; failure is not worth telling anyone about. */
function writeStoredRange(key: WorkspaceRangeKey): void {
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, key);
  } catch {
    /* ignore: a remembered range is a convenience, never a requirement */
  }
}

/** The workspace metrics page: headline figures, the hero chart and the ranked sections. */
export default function MetricsPageClient() {
  const [range, setRange] = useState<WorkspaceRangeKey>(WORKSPACE_DEFAULT_RANGE);
  /**
   * False until the remembered range has been read. The request waits for it rather than racing it:
   * reading storage during render would make the server's markup and the client's disagree (the
   * control rendered "30d" over a 7-day payload), and letting the effect fire a second request
   * instead meant a mount could ask the server for up to three different windows.
   */
  const [rangeReady, setRangeReady] = useState(false);
  const [metric, setMetric] = useState<MetricKey>("views");
  const [data, setData] = useState<WorkspaceMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to force a refetch: realtime activity, or the reader pressing Retry. */
  const [rev, setRev] = useState(0);
  /**
   * Set only when the *next* request must skip the server's 60s cache, and cleared as it is issued.
   * Tying freshness to `rev` instead made one realtime frame disable the cache for the life of the
   * tab, so every later range change re-ran the whole aggregation.
   */
  const freshRef = useRef(false);
  const [live, setLive] = useState(false);
  /** `now` is frozen per render pass so every "2 days ago" in one paint agrees. */
  const [now, setNow] = useState(() => Date.now());

  // The remembered range is read after mount, not during render, and the fetch below waits for it.
  // The last payload for that range, if this tab has one, paints at once; the request then
  // refreshes it under the pending bar (`src/lib/client/pageCache.ts`).
  useEffect(() => {
    const stored = readStoredRange();
    if (stored) setRange(stored);
    const cached = readPageCache<WorkspaceMetricsResponse>(`metrics:${stored ?? WORKSPACE_DEFAULT_RANGE}`);
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    setRangeReady(true);
  }, []);

  const { plan, loading: planLoading } = usePlan();
  const showSkeleton = useSkeletonDelay(loading || !data);
  // The payload is the authority once it arrives: it is the response that was actually served, and
  // `/api/plan` can fail (`usePlan` then answers `null` with `loading: false`, which read as "Pro"
  // and left a Free workspace with 30d highlighted over a 7-day body). `usePlan` only fills the gap
  // before the first payload.
  const isFree: boolean | null = data
    ? data.plan.isPro === false || data.range.clampedByPlan
    : planLoading && !plan
      ? null
      : plan?.plan === "free";
  // The plan clamps the window server-side anyway; asking for the window Free can actually have
  // keeps the control, the request and the response describing the same period.
  const effectiveRange: WorkspaceRangeKey = isFree === true ? "7d" : range;
  // Nothing is requested until both answers are in, so the first request is for the window this
  // browser actually wants, on the plan it actually has.
  const ready = rangeReady && isFree !== null;

  const onRangeChange = useCallback((next: WorkspaceRangeKey) => {
    setRange(next);
    writeStoredRange(next);
  }, []);

  useEffect(() => {
    const sync = () => setLive(realtimeState() === "open");
    sync();
    window.addEventListener(REALTIME_STATE_EVENT, sync);
    return () => window.removeEventListener(REALTIME_STATE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    // A refetch keeps the current numbers on screen and shows the thin pending bar; only the first
    // load (or a range change with nothing cached) blanks the page into the skeleton.
    const isFirst = data === null;
    if (isFirst) setLoading(true);
    else setPending(true);
    setError(null);
    const params = new URLSearchParams({ range: effectiveRange });
    if (freshRef.current) {
      params.set("fresh", "1");
      freshRef.current = false;
    }
    fetchWithTempUser(`/api/metrics/workspace?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Partial<WorkspaceMetricsResponse> & { error?: string };
        if (!res.ok || !json || json.ok !== true) throw new Error(json?.error || "Failed to load metrics.");
        if (cancelled) return;
        setData(json as WorkspaceMetricsResponse);
        writePageCache(`metrics:${effectiveRange}`, json);
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load metrics.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
    // `data` is read for the first-load check only; refetching when it changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRange, rev, ready]);

  // A recipient opening a document moves every number on this page, so coalesce the burst of
  // `share.*` frames into one refetch. Hidden tabs are skipped: they refetch when they come back.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeRealtime("activity", (frame) => {
      if (frame.type !== "activity") return;
      const type = frame.event.type ?? "";
      if (!type.startsWith("share.") && !type.startsWith("share_link.")) return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (document.visibilityState !== "visible") return;
        freshRef.current = true;
        setRev((r) => r + 1);
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  // Opens is withheld on a window whose visit rows are incomplete, so a reader who had selected it
  // before changing range would otherwise drive the chart from a tile that is no longer on screen.
  const shownMetric: MetricKey = metric === "opens" && data?.opensPartial ? "views" : metric;
  const rangeDays = data?.range.days ?? (effectiveRange === "7d" ? 7 : effectiveRange === "30d" ? 30 : 90);
  const previousDays = data?.range.previous ? rangeDays : 0;
  const emptyWorkspace = useMemo(
    () => Boolean(data) && data!.docsOpened.shared === 0 && data!.output.docsShared === 0 && data!.headline.views.value === 0,
    [data],
  );
  // Known empty before the numbers arrive. The plan snapshot is already in memory from the sidebar
  // and counts the workspace's documents; at zero there is nothing the aggregation can find, so
  // "No shared documents yet" paints at once instead of after a spinner-length wait for a payload
  // that only confirms it. The payload still wins when it lands (a deleted document's history can
  // leave views behind), which is why the request is not skipped.
  const knownEmpty = !data && plan?.usage.documents === 0;

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={ChartBarSquareIcon}
        title="Metrics"
        description="How your shared documents are doing across this workspace."
        badge={
          live ? (
            <span
              className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]"
              title="Updates arrive over the realtime connection"
            >
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--chart-views)]" />
              Live
            </span>
          ) : null
        }
        actions={<RangeControl value={effectiveRange} onChange={onRangeChange} isFree={isFree} disabled={loading} />}
      />

      <div className={`relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={loading || pending}>
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-5 -mt-6 mb-4 h-0.5 overflow-hidden bg-transparent sm:-mx-8">
            <div className="h-full w-1/3 bg-[var(--fg)]/60 motion-safe:animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
          </div>
        ) : null}

        {error ? (
          <Alert variant="error" className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                freshRef.current = true;
                setRev((r) => r + 1);
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Retry
            </button>
          </Alert>
        ) : null}

        {loading || !data ? (
          // A workspace the plan snapshot already knows has no documents gets its empty state on
          // the first paint. Otherwise nothing for the first fifth of a second: a workspace with
          // no documents was drawing a full dashboard of tiles and charts and then replacing it
          // with "No shared documents yet" — a promise of numbers that were never coming. See
          // `useSkeletonDelay`.
          knownEmpty ? <MetricsEmptyWorkspace /> : error || !showSkeleton ? null : <MetricsSkeleton />
        ) : emptyWorkspace ? (
          <MetricsEmptyWorkspace />
        ) : (
          <div className="grid gap-6">
            {/* Who opened something in this workspace, newest first, above everything else — the
                same strip the document and project metrics pages lead with, and now the same
                behaviour: a reading badge on every row, and a way through to the full list.

                `people.recent`, not `people.items`: the latter is the engagement ranking, already
                trimmed to eight, so sorting it by recency gave "the most engaged, newest first"
                under a heading that promises the newest. Someone who opened a document two minutes
                ago and read a page of it was missing from the strip that exists to show them.

                Named people only: the workspace payload identifies readers by person (an anonymous
                browser id is nobody a sender can act on — `WORKSPACE_PERSON_KEY_EXPR`), and on Free
                it identifies nobody, so the card simply does not appear there. The rows do not link
                anywhere, unlike the document and project strips: a reader page is scoped to one
                document or one room, and this person may have read several. */}
            <RecentVisitors
              visitors={data.people.recent.map((p) => ({
                key: p.key,
                name: (p.name ?? "").trim() || (p.email ?? "").trim() || null,
                lastSeen: p.lastSeenAt,
                /**
                 * What they read, not how many. "1 document" is the one fact on this row nobody
                 * needed — the name of the document is the answer to the question the card asks,
                 * and it goes in the chip beside their name where the other pages put the project.
                 * The count survives only when it adds something: a reader of several documents
                 * gets "+2 more" after the one their badge is about.
                 */
                detail: [
                  p.readingTimeMs > 0 ? formatDurationShort(p.readingTimeMs) : null,
                  p.docs > 1 ? `+${p.docs - 1} more` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null,
                vias: p.docTitle && p.depthSample
                  ? [{ name: p.docTitle, href: `/doc/${encodeURIComponent(p.depthSample.docId)}/metrics`, kind: "doc" as const }]
                  : [],
                /**
                 * The badge is judged on one real reading, not on a workspace-wide average.
                 *
                 * Fed the workspace's own unit — documents — every row came out READ, including a
                 * reader the document's own page calls SKIMMED. So the payload carries the inputs
                 * of the single document this person spent longest in (`depthSample`), and the
                 * same `readingDepth` runs here as everywhere else. The word on this card is now
                 * the word you find when you click through to that reading.
                 */
                timeMs: p.depthSample?.timeMs ?? null,
                pages: p.depthSample?.pages ?? null,
                totalPages: p.depthSample?.totalPages ?? null,
                // The same destination the badge is about: their page for the document they spent
                // longest in. Null when that reading came through a project link, whose readers
                // live on the project's pages rather than the document's.
                href: p.readerHref,
                hint: p.readerHref ? "See what they read" : undefined,
              }))}
              // The payload trims the recency slice to five, so the true count comes separately.
              total={data.people.count}
              seeAllLabel="See all readers"
              onSeeAll={() => {
                document.getElementById("workspace-people")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />

            <HeadlineStrip
              headline={data.headline}
              selected={shownMetric}
              onSelect={setMetric}
              previousDays={previousDays}
              docsOpened={data.docsOpened}
              opensPartial={data.opensPartial}
            />

            <HeroChart series={data.series} metric={shownMetric} rangeDays={rangeDays} />

            {/*
              Two independent columns on a wide screen, not a 2x2 grid: a grid row is as tall as its
              tallest card, so a three-row Top documents beside an eight-row Top links opened a
              500px hole above "Most engaged people". Each column stacks its own two sections instead.

              Narrow screens collapse to one column, where the sections must still appear in the
              PRD's order — documents, links, people, quiet. The columns become `display: contents`
              there, so all four cards are direct items of the outer grid, and `order` interleaves
              them back into that order.
            */}
            <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
              <div className="contents lg:grid lg:auto-rows-min lg:gap-6">
                <div className="order-1 min-w-0 lg:order-none">
                  <TopDocsSection docs={data.topDocs} now={now} opensPartial={data.opensPartial} />
                </div>
                <div className="order-3 min-w-0 lg:order-none" id="workspace-people">
                  <PeopleSection people={data.people} now={now} />
                </div>
              </div>
              <div className="contents lg:grid lg:auto-rows-min lg:gap-6">
                <div className="order-2 min-w-0 lg:order-none">
                  <TopLinksSection links={data.topLinks} now={now} />
                </div>
                <div className="order-4 min-w-0 lg:order-none">
                  <QuietDocsSection docs={data.quietDocs} now={now} />
                </div>
                {/* The workspace's own side of the period, under the reader-facing sections: who
                    added, shared and replaced, with agents credited to their client. */}
                <div className="order-5 min-w-0 lg:order-none">
                  <ContributorsSection contributors={data.contributors} now={now} />
                </div>
              </div>
            </div>

            <p className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5 text-[12px] text-[var(--muted-2)]">
              {outputSentence(rangeDays, data.output)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
