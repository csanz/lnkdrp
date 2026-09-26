"use client";

/**
 * Client UI for `/activity`.
 *
 * Renders the workspace activity feed grouped by day with type filters and Previous/Next paging
 * (cursor-based under the hood: the cursor that opened each page is kept so Previous can replay it).
 */

import GetStartedActions from "@/components/onboarding/GetStartedActions";
import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpTrayIcon, CheckCircleIcon, ClockIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { usePlan } from "@/lib/client/usePlan";
import { REALTIME_STATE_EVENT, realtimeState, subscribeRealtime } from "@/lib/client/realtime";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ACTIVITY_FILTERS, type ActivityFilterId } from "@/lib/activity/labels";
import {
  ActivityDayGroups,
  ActivityFeedSkeleton,
  ActivityPager,
  ActivityTypeTabs,
  DEFAULT_ACTIVITY_PAGE_SIZE,
  DayHeading,
  activityTabClass,
  groupByDay,
} from "@/components/activity/ActivityRows";
import { useActivityPages } from "@/components/activity/useActivityPages";
import {
  markDocFinished,
  mergeInFlightSnapshot,
  mergeUploadFrame,
  pruneUploads,
  type InFlightUpload,
} from "@/lib/uploads/inFlight";
import { isTerminalUploadStatus } from "@/lib/uploads/progress";
import ActivityStatsHeader from "./StatsHeader";

/** How long a finished upload's row takes to fold away; matches the sidebar's leaving rows. */
const UPLOAD_ROW_LEAVE_MS = 1200;

/**
 * Keep a row in the list while it folds away.
 *
 * A settled upload used to disappear between renders, so the section (and everything under it)
 * jumped up by a row. The row that left is held at the index it left from, marked `leaving`, and
 * collapses on the same curve and duration as the sidebar's archived/deleted rows.
 */
function useFoldingUploads(items: InFlightUpload[]): Array<{ item: InFlightUpload; leaving: boolean }> {
  const [leaving, setLeaving] = useState<Array<{ item: InFlightUpload; index: number }>>([]);
  const prevRef = useRef<InFlightUpload[]>([]);
  const timersRef = useRef<number[]>([]);
  useEffect(() => () => timersRef.current.forEach((t) => window.clearTimeout(t)), []);
  // Layout effect: the ghost must be in place before the browser paints the list without the row,
  // or the rows below jump for a frame and then back.
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = items;
    const nextIds = new Set(items.map((u) => u.id));
    // An upload that came back (a retry writing progress again) drops its ghost.
    setLeaving((cur) => (cur.some((l) => nextIds.has(l.item.id)) ? cur.filter((l) => !nextIds.has(l.item.id)) : cur));
    if (!prev.length) return;
    const removed = prev.map((item, index) => ({ item, index })).filter(({ item }) => !nextIds.has(item.id));
    if (!removed.length) return;
    setLeaving((cur) => [...cur.filter((l) => !removed.some((r) => r.item.id === l.item.id)), ...removed]);
    const ids = new Set(removed.map((r) => r.item.id));
    const t = window.setTimeout(() => setLeaving((cur) => cur.filter((l) => !ids.has(l.item.id))), UPLOAD_ROW_LEAVE_MS + 50);
    timersRef.current.push(t);
  }, [items]);
  return useMemo(() => {
    const rows = items.map((item) => ({ item, leaving: false }));
    for (const l of [...leaving].sort((a, b) => a.index - b.index)) {
      rows.splice(Math.min(l.index, rows.length), 0, { item: l.item, leaving: true });
    }
    return rows;
  }, [items, leaving]);
}

/**
 * One upload that is still happening.
 *
 * The feed's own rows are all past tense — they exist because something finished. This is the one
 * thing on the page that is still going, so it gets the only moving element: a hairline bar, the
 * percent, and the stage the pipeline is actually in ("rendering page 3 of 9"), all of it fed by
 * `upload` frames off the realtime channel rather than a poll. It keeps the row grammar of
 * everything below it — icon tile, title, a small second line — so the section reads as part of
 * the feed and not a widget bolted above it.
 */
function UploadProgressRow({ item, leaving = false }: { item: InFlightUpload; leaving?: boolean }) {
  const failed = item.status === "failed";
  const done = item.status === "completed";
  const Icon = failed ? XCircleIcon : done ? CheckCircleIcon : ArrowUpTrayIcon;
  const title = item.docTitle?.trim() || "Untitled document";
  const href = item.docId ? `/doc/${encodeURIComponent(item.docId)}` : null;
  const percent = Math.max(0, Math.min(100, Math.round(item.percent)));
  // A replacement says so: "v3" is how an owner tells this bar apart from the first upload's.
  const version = typeof item.version === "number" && item.version > 1 ? `v${item.version}` : null;

  return (
    // A row that has settled folds away instead of vanishing: the <li> is a one-row grid so
    // 1fr -> 0fr collapses it to its own height, the same curve the sidebar's leaving rows use.
    <li
      className={
        leaving
          ? "pointer-events-none grid motion-safe:animate-[ldSidebarRowOut_1.2s_cubic-bezier(0.33,0,0.2,1)_forwards] motion-reduce:animate-[ldSidebarRowFade_1.2s_linear_forwards]"
          : "grid"
      }
      aria-hidden={leaving ? "true" : undefined}
    >
      <div className="min-h-0 [overflow-y:clip]">
        <div className="flex items-start gap-3 px-4 py-3">
        <div
          className={[
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-[var(--border)]",
            failed ? "bg-[var(--panel-hover)] text-[var(--danger-fg)]" : "bg-[var(--panel-hover)] text-[var(--muted-2)]",
          ].join(" ")}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-x-2 text-[13px] leading-5 text-[var(--muted)]">
            {href ? (
              <Link href={href} className="min-w-0 truncate font-semibold text-[var(--fg)] hover:underline underline-offset-4">
                {title}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-semibold text-[var(--fg)]">{title}</span>
            )}
            {version ? <span className="shrink-0 text-[11px] text-[var(--muted-2)]">{version}</span> : null}
            <span
              className={[
                "ml-auto shrink-0 text-[12px] font-semibold tabular-nums",
                // red-400 was picked on the dark panel: 2.52:1 on a light one, on the one word that says
                // an upload broke. `--danger-fg` keeps the dark value and gives light its own.
                failed ? "text-[var(--danger-fg)]" : "text-[var(--fg)]",
              ].join(" ")}
            >
              {failed ? "Failed" : `${percent}%`}
            </span>
          </div>
          {/* The bar. Width is the only thing that animates, so a frame arriving mid-transition
              simply retargets it instead of restarting anything. */}
          <div
            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${title}: ${item.stage}`}
          >
            <div
              className={[
                "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                failed ? "bg-[var(--danger-bar)]" : done ? "bg-[var(--chart-views)]" : "bg-[var(--fg)]",
              ].join(" ")}
              style={{ width: `${failed ? Math.max(percent, 4) : percent}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--muted-2)]" aria-live="polite">
            {failed ? "Upload failed" : done ? "Ready" : item.stage}
          </div>
        </div>
        </div>
      </div>
    </li>
  );
}

/** The workspace feed: what everyone and everything did here, newest first. */
export default function ActivityPageClient() {
  const [filter, setFilter] = useState<ActivityFilterId>("all");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_ACTIVITY_PAGE_SIZE);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const types = useMemo(() => ACTIVITY_FILTERS.find((f) => f.id === filter)?.types ?? [], [filter]);
  // Second axis: who did it. "Teammates" is the team-activity story; on Free it opens the
  // collaborator upsell instead of filtering, since a Free workspace has no teammates to show.
  const [who, setWho] = useState<"all" | "me" | "team" | "agents">("all");

  // The feed itself: paging, the cached first paint and live arrivals all live in the hook, which
  // the contributor pages share (`src/components/activity/useActivityPages.ts`).
  const { items, freshIds, nextCursor, pageIndex, loading, showSkeleton, pending, leaving, pageKey, error, goToPage } =
    useActivityPages({ filterId: filter, types, who, pageSize, scrollRef: feedRef });
  // Deep-linkable: /activity?who=agents (the sidebar's "N connected" lands here). Read once on
  // mount, mirror changes back into the URL without a navigation.
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get("who");
    if (w === "me" || w === "team" || w === "agents") setWho(w);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (who === "all") url.searchParams.delete("who");
    else url.searchParams.set("who", who);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [who]);
  // "Live" badge while the realtime socket is open.
  const [live, setLive] = useState(false);
  useEffect(() => {
    const sync = () => setLive(realtimeState() === "open");
    sync();
    window.addEventListener(REALTIME_STATE_EVENT, sync);
    return () => window.removeEventListener(REALTIME_STATE_EVENT, sync);
  }, []);
  const { plan } = usePlan();
  const isFree = plan?.plan === "free";
  const { openUpgrade } = useUpgradeModal();

  /**
   * Uploads still in flight, drawn above the feed.
   *
   * Two inputs. `GET /api/uploads/in-progress` is the snapshot — without it a page opened partway
   * through a long import would be blank until the next frame happened to land. `upload` frames
   * are everything after that, and they also carry the titles' only refresh trigger: a frame for
   * an id we have never seen means an upload started somewhere else (another tab, an agent), so we
   * re-fetch the snapshot once to learn which document it is on.
   */
  const [inFlight, setInFlight] = useState<InFlightUpload[]>([]);
  // Settled rows stay one beat longer so the section folds shut instead of jumping.
  const inFlightRows = useFoldingUploads(inFlight);
  // Every row left: the block itself is what folds, not each row inside it.
  const sectionLeaving = inFlightRows.length > 0 && inFlightRows.every((r) => r.leaving);
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    inFlightIdsRef.current = new Set(inFlight.map((u) => u.id));
  }, [inFlight]);

  const loadInFlight = useCallback(async () => {
    try {
      const res = await fetchWithTempUser("/api/uploads/in-progress", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json().catch(() => ({}))) as { items?: InFlightUpload[] };
      const items = Array.isArray(json.items) ? json.items : [];
      setInFlight((prev) => mergeInFlightSnapshot(prev, items));
    } catch {
      // The feed itself is unaffected; the bars just wait for the next frame.
    }
  }, []);

  useEffect(() => {
    void loadInFlight();
    const onUpload = (frame: { type: string }) => {
      const f = frame as { type: "upload"; upload: { id: string; docId: string | null; percent: number; stage: string | null; status: string | null } };
      if (f.type !== "upload" || !f.upload?.id) return;
      const unknown = !inFlightIdsRef.current.has(f.upload.id);
      setInFlight((prev) => mergeUploadFrame(prev, f.upload));
      // Frames carry no title (the realtime server stays free of per-frame lookups), so the first
      // sighting of an upload is what sends us back for the document it belongs to.
      if (unknown && !isTerminalUploadStatus(f.upload.status)) void loadInFlight();
    };
    const onDoc = (frame: { type: string }) => {
      const f = frame as { type: "doc"; doc: { id: string; status: string | null } };
      if (f.type !== "doc" || !f.doc?.id) return;
      // The document's flip usually beats the pipeline's last progress write, and it is the more
      // authoritative "it is over": settle the bar on it rather than leaving it at 96%.
      setInFlight((prev) => markDocFinished(prev, f.doc.id, f.doc.status));
    };
    const offUpload = subscribeRealtime("upload", onUpload);
    const offDoc = subscribeRealtime("doc", onDoc);
    // Finished entries hold their filled bar for a beat, then go; the feed row that replaced them
    // has already arrived underneath by then.
    const prune = window.setInterval(() => setInFlight((prev) => pruneUploads(prev)), 1000);
    // Fallback for a deployment with no realtime url (the socket stays "unavailable"): a slow poll
    // is better than a bar that never moves.
    const poll = window.setInterval(() => {
      if (realtimeState() === "open" || document.visibilityState !== "visible") return;
      void loadInFlight();
    }, 5000);
    return () => {
      offUpload();
      offDoc();
      window.clearInterval(prune);
      window.clearInterval(poll);
    };
  }, [loadInFlight]);

  const groups = useMemo(() => groupByDay(items), [items]);

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={ClockIcon}
        title="Activity"
        description="Uploads, share changes, views and agent activity in this workspace, by everyone in it."
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
      >
        {/* Two filter axes on one row (wrapping on narrow screens), separated by a hairline. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <ActivityTypeTabs value={filter} onChange={setFilter} />

        <div aria-hidden="true" className="hidden h-6 w-px bg-[var(--border)] sm:block" />
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Who did it">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">Who</span>
          {(
            [
              { id: "all", label: "Everyone" },
              { id: "me", label: "Me" },
              { id: "team", label: "Teammates" },
              { id: "agents", label: "Agents" },
            ] as const
          ).map((w) => {
            const active = w.id === who;
            const gated = w.id === "team" && isFree;
            return (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={gated ? "Collaborators are a Pro feature" : undefined}
                onClick={() => {
                  if (gated) {
                    openUpgrade("collaborators");
                    return;
                  }
                  setWho(w.id);
                }}
                className={activityTabClass(active)}
              >
                {w.label}
                {gated ? <span className="ml-1.5 rounded px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--muted-2)] ring-1 ring-[var(--border)]">Pro</span> : null}
              </button>
            );
          })}
        </div>
        </div>
      </AppPageHeader>

      <div ref={feedRef} className={`relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={pending || loading}>
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-8 -mt-6 mb-4 h-0.5 overflow-hidden bg-transparent">
            <div className="h-full w-1/3 bg-[var(--fg)]/60 motion-safe:animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {/* What was done here over the last 30 days, and who did it. Workspace-wide and outside the
            feed's filters and paging: it is the page's standing summary, not a view of the rows
            below it. It draws nothing at all until it has numbers worth showing. */}
        <ActivityStatsHeader />

        {/* In-flight uploads sit above the feed and outside its loading/empty states: the one thing
            on this page that is happening now should not wait on a page of things that already
            happened, and an empty workspace whose first upload is mid-flight is the opposite of
            "no activity yet". */}
        {inFlightRows.length ? (
          // When the last upload settles the whole block goes, heading included: folding only the
          // row left the "In progress" label and the panel border to blink out at the end. With
          // nothing left to keep, the section folds as one and the rows inside hold still.
          <section
            aria-label="Uploads in progress"
            aria-hidden={sectionLeaving ? "true" : undefined}
            className={
              sectionLeaving
                ? "grid motion-safe:animate-[ldSidebarRowOut_1.2s_cubic-bezier(0.33,0,0.2,1)_forwards] motion-reduce:animate-[ldSidebarRowFade_1.2s_linear_forwards] pointer-events-none"
                : "mb-6"
            }
          >
            <div className={sectionLeaving ? "min-h-0 [overflow-y:clip]" : undefined}>
              <div className={sectionLeaving ? "mb-6" : undefined}>
                <DayHeading>In progress</DayHeading>
                <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  <ul className="divide-y divide-[var(--border)]">
                    {inFlightRows.map(({ item, leaving }) => (
                      <UploadProgressRow
                        key={leaving ? `leaving-${item.id}` : item.id}
                        item={item}
                        leaving={leaving && !sectionLeaving}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* Nothing for the first fifth of a second: six pulsing rows that resolve into "no
            activity yet" promise a feed that was never coming. See `useSkeletonDelay`. */}
        {loading ? (
          !showSkeleton ? null : <ActivityFeedSkeleton />
        ) : !items.length ? (
          inFlightRows.length ? null : (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--muted)]">
              No activity yet. Uploads, share changes and views will show up here.
              <GetStartedActions />
            </div>
          )
        ) : (
          <div
            key={pageKey}
            className={[
              "grid gap-6 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              leaving ? "translate-y-1 opacity-40" : "translate-y-0 opacity-100",
            ].join(" ")}
          >
            <ActivityDayGroups groups={groups} freshIds={freshIds} />

            <ActivityPager
              pageIndex={pageIndex}
              pageSize={pageSize}
              onPageSize={setPageSize}
              nextCursor={nextCursor}
              itemCount={items.length}
              loading={loading}
              pending={pending}
              onGoToPage={(i) => void goToPage(i)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
