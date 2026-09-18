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
import RangeControl from "@/components/workspaceMetrics/RangeControl";
import {
  ContributorsSection,
  PeopleSection,
  QuietDocsSection,
  TopDocsSection,
  TopLinksSection,
} from "@/components/workspaceMetrics/Sections";
import { outputSentence, type MetricKey } from "@/components/workspaceMetrics/format";
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
  useEffect(() => {
    const stored = readStoredRange();
    if (stored) setRange(stored);
    setRangeReady(true);
  }, []);

  const { plan, loading: planLoading } = usePlan();
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
          error ? null : <MetricsSkeleton />
        ) : emptyWorkspace ? (
          <MetricsEmptyWorkspace />
        ) : (
          <div className="grid gap-6">
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
                <div className="order-3 min-w-0 lg:order-none">
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
