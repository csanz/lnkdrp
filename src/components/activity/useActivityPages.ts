"use client";

/**
 * The activity feed's cursor paging, as a hook two pages can share.
 *
 * `/api/activity` pages with a keyset cursor: it hands back the cursor that opens the *next* page
 * and nothing that would let you jump backwards. Previous therefore has to be remembered rather
 * than computed, which is what `cursors` is - the cursor that opened page *i*, kept so that going
 * back replays exactly the request that produced it. That is the whole reason this is a state
 * machine and not a `page=` number, and it is too much machinery to write twice: `/activity` and
 * the contributor pages (`/people/:id`, `/agents/:client/:owner`) are the same feed with a
 * different filter.
 *
 * Live arrivals belong here too, for the same reason: a row that lands over the realtime channel
 * while you are reading is staged in one at a time and highlighted, and every rule about that is a
 * rule about the paged list underneath it (only page one shows arrivals; a filter change or a page
 * turn throws the queue away, or a page-one row is prepended onto page two). Splitting the queue
 * from the list would mean handing every caller the state setters and trusting it to obey them.
 *
 * What stays with the caller: the chrome. `/activity` keeps its who-axis, its "Live" badge and its
 * in-flight upload bars; a contributor page keeps its profile header. Both just render `items`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { peekKnownEmpty } from "@/lib/client/knownEmpty";
import { realtimeState, subscribeRealtime } from "@/lib/client/realtime";
import { readPageCache, writePageCache } from "@/lib/client/pageCache";
import { useSkeletonDelay } from "@/lib/client/useSkeletonDelay";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { ActivityItem } from "@/lib/activity/labels";

/** Minimum time a page transition takes, so the leave/enter choreography reads as one motion. */
export const PAGE_TRANSITION_MIN_MS = 280;

/** One page of the feed, as `/api/activity` answers it. */
export type ActivityPage = { items: ActivityItem[]; nextCursor: string | null };

/** What a feed has to tell the hook to fetch the right rows. */
export type UseActivityPagesOptions = {
  /**
   * The type-filter's id, used only to key the paint-immediately cache. It is the filter's *name*
   * rather than its types so a cache entry survives a type being added to a filter group.
   */
  filterId: string;
  /** Event types to ask for; empty means no type filter. */
  types: readonly string[];
  /** The who-axis (`all` sends no param). Ignored by the API when `actor` is set. */
  who: string;
  /** A serialised `ContributorKey`: one person's or one agent's rows. */
  actor?: string | null;
  pageSize: number;
  /** The scrolling element to glide to the top on a page change. */
  scrollRef?: RefObject<HTMLElement | null>;
};

/** Everything a feed needs in order to render itself. */
export type ActivityPages = {
  items: ActivityItem[];
  /** Ids that arrived live and are still highlighted; hand them to `ActivityDayGroups`. */
  freshIds: ReadonlySet<string>;
  nextCursor: string | null;
  /** Zero-based; `cursors` stays private because only `goToPage` may act on it. */
  pageIndex: number;
  loading: boolean;
  /** `loading`, delayed, so a fast answer never flashes a skeleton. */
  showSkeleton: boolean;
  /** A page transition is running. */
  pending: boolean;
  /** The outgoing rows are dimmed and lifted. */
  leaving: boolean;
  /** Changes on every page swap so rows remount and replay their enter animation. */
  pageKey: number;
  error: string | null;
  goToPage: (index: number) => Promise<void>;
};

/**
 * Page `/api/activity`, remembering how each page was opened.
 *
 * The first page also paints from this tab's last answer for the same filter before the network
 * has said anything (`src/lib/client/pageCache.ts`), and a workspace the sidebar snapshot already
 * knows is empty skips straight to the empty state - neither is an optimisation, they are the
 * difference between a feed that appears and a feed that blinks.
 */
export function useActivityPages(options: UseActivityPagesOptions): ActivityPages {
  const { filterId, types, who, actor = null, pageSize, scrollRef } = options;
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // cursors[i] is the cursor that opened page i (null for the first page); pageIndex points at the current page.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const showSkeleton = useSkeletonDelay(loading);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pageKey, setPageKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Live arrivals: highlighted while fresh, then back to no animation. New rows are queued and
  // inserted one at a time, oldest first, so a burst reads as a sequence instead of a wall.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const freshTimersRef = useRef<number[]>([]);
  const arrivalQueueRef = useRef<ActivityItem[]>([]);
  const drainTimerRef = useRef<number | null>(null);
  // Read by the refresh and the drain, which both run from timers that captured an older
  // `pageIndex`: a page-one refresh answered after Next was clicked used to prepend its rows
  // onto page two (code review 2026-09-23, Low).
  const pageIndexRef = useRef(0);
  const lastInsertAtRef = useRef(0);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);
  useEffect(
    () => () => {
      freshTimersRef.current.forEach((t) => window.clearTimeout(t));
      if (drainTimerRef.current !== null) window.clearTimeout(drainTimerRef.current);
    },
    [],
  );

  const FRESH_MS = 7200;
  const STAGE_MS = 1400;
  /** Insert the next queued arrival at the top, highlighted, then schedule the one after it. */
  const drainArrivals = useCallback(() => {
    drainTimerRef.current = null;
    if (!arrivalQueueRef.current.length) return;
    if (pageIndexRef.current !== 0) {
      // Only page one shows arrivals; the page-one fetch on the way back replaces the list anyway.
      arrivalQueueRef.current = [];
      return;
    }
    // Minimum spacing between inserts, even when arrivals come from separate refreshes a few
    // milliseconds apart (three quick writes = three frames = three refetches).
    const wait = STAGE_MS - (Date.now() - lastInsertAtRef.current);
    if (wait > 0) {
      drainTimerRef.current = window.setTimeout(drainArrivals, wait);
      return;
    }
    const next = arrivalQueueRef.current.shift();
    if (!next) return;
    lastInsertAtRef.current = Date.now();
    setItems((prev) => (prev.some((it) => it.id === next.id) ? prev : [next, ...prev].slice(0, pageSize)));
    setFreshIds((cur) => new Set([...cur, next.id]));
    const t = window.setTimeout(() => {
      setFreshIds((cur) => {
        const out = new Set(cur);
        out.delete(next.id);
        return out;
      });
    }, FRESH_MS);
    freshTimersRef.current.push(t);
    if (arrivalQueueRef.current.length) drainTimerRef.current = window.setTimeout(drainArrivals, STAGE_MS);
  }, [pageSize]);

  /**
   * Throw away anything still waiting to be staged in, whenever the list is replaced.
   *
   * Live rows arrive in a burst and are drained one per `STAGE_MS`, so up to several seconds of
   * them can be queued when the filter changes. The load effect below replaces `items` wholesale
   * and used to leave the queue and its timer alone, so the pending drain fired afterwards and
   * prepended a row belonging to the *previous* filter onto the new feed - highlighted as a fresh
   * arrival, with `.slice(0, pageSize)` quietly dropping a legitimate row off the end to make
   * room. On a paged view it put a page-one row at the top of page two.
   *
   * `tick` already refuses to enqueue while `pageIndex !== 0`; nothing guarded the draining.
   */
  const resetArrivals = useCallback(() => {
    arrivalQueueRef.current = [];
    if (drainTimerRef.current !== null) {
      window.clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
  }, []);

  /**
   * The `type` query value, as a string rather than the array.
   *
   * Everything downstream keys off this, so a caller that builds `types` inline (a fresh array on
   * every render) still gets one fetch per actual filter change instead of an endless loop.
   */
  const typeParam = useMemo(() => types.join(","), [types]);

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<ActivityPage> => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      if (typeParam) params.set("type", typeParam);
      if (who !== "all") params.set("who", who);
      // One contributor's rows. The API ignores `who` when this is set (both are the actor axis).
      if (actor) params.set("actor", actor);
      if (cursor) params.set("cursor", cursor);
      const res = await fetchWithTempUser(`/api/activity?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        items?: ActivityItem[];
        nextCursor?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error || "Failed to load activity.");
      return {
        items: Array.isArray(json.items) ? json.items : [],
        nextCursor: typeof json.nextCursor === "string" ? json.nextCursor : null,
      };
    },
    [typeParam, who, actor, pageSize],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCursors([null]);
    setPageIndex(0);
    resetArrivals();
    // The first page this tab last saw for this filter paints at once and refreshes underneath
    // (`src/lib/client/pageCache.ts`). Failing that, a workspace the sidebar snapshot says has no
    // activity row at all gets "No activity yet" on the first frame; the snapshot carries that
    // fact precisely because document and project counts cannot stand in for it (member and
    // agent rows exist without either). The response still wins when it lands.
    const cacheKey = `activity:${filterId}:${who}:${actor ?? ""}`;
    const cached = readPageCache<ActivityPage>(cacheKey);
    if (cached) {
      setItems(cached.items);
      setNextCursor(cached.nextCursor);
      setLoading(false);
    } else if (peekKnownEmpty().activity === true) {
      setItems([]);
      setNextCursor(null);
      setLoading(false);
    }
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        writePageCache(cacheKey, page);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load activity.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `filterId`, `who` and `actor` only name the cache entry; `fetchPage` is what actually changes
    // when any of them do, and it is the dependency the original effect had.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  // Live-ish feed: while the tab is visible and on the first page, re-check every 10s (and on
  // focus) and swap in the new first page when anything changed. Polling stands in for the push
  // channel planned on the Node host (see docs/prds/lnkdrp-mcp.md, Future).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible" || pageIndex !== 0 || pending || loading) return;
      fetchPage(null)
        .then((page) => {
          // The tab moved off page one while this was in flight.
          if (pageIndexRef.current !== 0) return;
          setItems((prev) => {
            /**
             * Identity, not just arrival.
             *
             * This compared ids alone, and a rename is a *read-time join* onto rows that already
             * exist — same ids, same count, same order. So the refetch triggered by a `viewer`
             * frame fetched the corrected names and then threw them away, and the feed went on
             * saying "Someone" until it was reloaded by hand: exactly what subscribing to that
             * frame was meant to fix.
             */
            const identity = (it: (typeof page.items)[number]) =>
              `${it.id}:${it.actor?.name ?? ""}:${it.actor?.email ?? ""}:${String((it.meta as Record<string, unknown> | undefined)?.viewerName ?? "")}`;
            const changed =
              page.items.length !== prev.length || page.items.some((it, i) => identity(it) !== (prev[i] ? identity(prev[i]) : ""));
            if (!changed) return prev;
            // Same rows, new names: swap them in wholesale rather than running the arrivals
            // animation, which exists for rows that are genuinely new.
            const sameIds =
              page.items.length === prev.length && page.items.every((it, i) => it.id === prev[i]?.id);
            if (sameIds) return page.items;
            if (!prev.length) return page.items;
            const known = new Set([...prev.map((it) => it.id), ...arrivalQueueRef.current.map((it) => it.id)]);
            // Newest first on the wire; enqueue oldest first so each insert lands above the last.
            const arrived = page.items.filter((it) => !known.has(it.id)).reverse();
            if (arrived.length) {
              arrivalQueueRef.current.push(...arrived);
              if (drainTimerRef.current === null) drainTimerRef.current = window.setTimeout(drainArrivals, 0);
              return prev;
            }
            // Nothing new. While arrivals are still being staged, leave the list alone: mirroring the
            // server order mid-stage is what made rows appear below the top one. Once the queue is
            // empty, mirror quietly (a delete elsewhere, or a row aging out of the page).
            if (arrivalQueueRef.current.length) return prev;
            return page.items;
          });
          setNextCursor(page.nextCursor);
        })
        .catch(() => {
          // Background refresh; the visible feed stays as it was.
        });
    };
    // Push: a new activity row in this workspace arrives as an "activity" frame; refetch page one
    // right away. The 10s timer is only a fallback: it skips its fetch while the socket is open.
    const unsubscribe = subscribeRealtime("activity", () => tick());
    // A recipient's name is joined onto their past rows at read time, so a rename changes what the
    // feed *says* without adding a row — no "activity" frame, nothing to react to, and the page sat
    // there showing "Someone" until it was reloaded by hand.
    const unsubscribeViewer = subscribeRealtime("viewer", () => tick());
    const timer = window.setInterval(() => {
      if (realtimeState() === "open") return;
      tick();
    }, 10_000);
    window.addEventListener("focus", tick);
    return () => {
      unsubscribe();
      unsubscribeViewer();
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [fetchPage, pageIndex, pending, loading, drainArrivals]);

  /**
   * Page transition choreography: dim and lift the current rows, glide the feed to the top, fetch
   * the next page, then let the new rows fade up in a short stagger. Never blanks the list.
   */
  const goToPage = useCallback(
    async (index: number) => {
      if (loading || pending) return;
      const cursor = index < cursors.length ? cursors[index] : nextCursor;
      if (index > 0 && !cursor) return;
      const reduceMotion =
        typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      setPending(true);
      setLeaving(true);
      setError(null);
      // Same reason as the load effect above: a staged arrival that fires mid-transition lands on
      // the page you are moving to, where it does not belong.
      resetArrivals();
      scrollRef?.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      const minWait = new Promise<void>((r) => window.setTimeout(r, reduceMotion ? 0 : PAGE_TRANSITION_MIN_MS));
      try {
        const [page] = await Promise.all([fetchPage(cursor ?? null), minWait]);
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setCursors((prev) => (index < prev.length ? prev : [...prev, cursor ?? null]));
        setPageIndex(index);
        setPageKey((k) => k + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load activity.");
      } finally {
        setLeaving(false);
        setPending(false);
      }
    },
    [cursors, fetchPage, loading, nextCursor, pending, resetArrivals, scrollRef],
  );

  return {
    items,
    freshIds,
    nextCursor,
    pageIndex,
    loading,
    showSkeleton,
    pending,
    leaving,
    pageKey,
    error,
    goToPage,
  };
}
