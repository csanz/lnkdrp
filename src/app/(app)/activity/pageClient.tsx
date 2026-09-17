"use client";

/**
 * Client UI for `/activity`.
 *
 * Renders the workspace activity feed grouped by day with type filters and Previous/Next paging
 * (cursor-based under the hood: the cursor that opened each page is kept so Previous can replay it).
 */

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArchiveBoxXMarkIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  EyeIcon,
  GlobeAltIcon,
  InboxArrowDownIcon,
  KeyIcon,
  LinkIcon,
  LinkSlashIcon,
  LockClosedIcon,
  LockOpenIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { usePlan } from "@/lib/client/usePlan";
import { REALTIME_STATE_EVENT, realtimeState, subscribeRealtime } from "@/lib/client/realtime";
import AgentMark from "@/components/AgentMark";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import {
  ACTIVITY_FILTERS,
  actorDisplayName,
  describeActivity,
  type ActivityFilterId,
  type ActivityItem,
} from "@/lib/activity/labels";

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
/** Minimum time a page transition takes, so the leave/enter choreography reads as one motion. */
const PAGE_TRANSITION_MIN_MS = 280;

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const ICON_BY_TYPE: Record<string, HeroIcon> = {
  "doc.created": DocumentPlusIcon,
  "doc.imported_url": GlobeAltIcon,
  "upload.completed": ArrowUpTrayIcon,
  "doc.processed": CpuChipIcon,
  "doc.replaced": ArrowPathIcon,
  "doc.deleted": TrashIcon,
  "doc.archived": ArchiveBoxIcon,
  "doc.unarchived": ArchiveBoxXMarkIcon,
  "share.viewed": EyeIcon,
  "share.downloaded": ArrowDownTrayIcon,
  "share_link.created": LinkIcon,
  "share_link.updated": AdjustmentsHorizontalIcon,
  "share_link.revoked": LinkSlashIcon,
  "share_link.password_revealed": KeyIcon,
  "share.updated": LinkIcon,
  "share.password_set": LockClosedIcon,
  "share.password_cleared": LockOpenIcon,
  "request_repo.created": InboxArrowDownIcon,
  "request.upload_received": InboxArrowDownIcon,
  "download_request.created": ArrowDownTrayIcon,
  "download_request.approved": CheckCircleIcon,
  "download_request.denied": XCircleIcon,
};

/** Render a user-friendly relative time string for ISO timestamps. */
function formatRelative(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "Just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "min" : "mins"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Local-date key (YYYY-MM-DD) used to group rows by day. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Today" / "Yesterday" / "Sep 10, 2026" for a day key. */
function dayLabel(key: string): string {
  if (key === "unknown") return "Earlier";
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const [y, m, d] = key.split("-").map((s) => Number(s));
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Where a row should link: the doc (unless deleted), else the project, else nowhere. */
function hrefFor(item: ActivityItem): string | null {
  if (item.doc?.id && item.type !== "doc.deleted" && !item.doc?.deleted) return `/doc/${encodeURIComponent(item.doc.id)}`;
  if (item.project?.id) return `/project/${encodeURIComponent(item.project.id)}`;
  return null;
}

/**
 * Who did it, as avatars. A person alone is one initials circle; an agent acting for a person is
 * the pair stacked like GitHub's co-authored commits (person in front, agent behind); an agent with
 * no known person is the agent circle alone.
 */
function ActorAvatar({ item }: { item: ActivityItem }) {
  const name = actorDisplayName(item.actor);
  const agent = item.agent;
  const agentTitle = agent ? (agent.version ? `${agent.label} ${agent.version}` : agent.label) : null;
  const person = name ? (
    <div
      className="grid h-7 w-7 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]"
      title={item.actor.email ?? name}
    >
      {initialsFromNameOrEmail(name)}
    </div>
  ) : null;
  const bot = agent ? (
    <div
      className="grid h-7 w-7 place-items-center rounded-full bg-[var(--panel)] text-[var(--muted)] ring-1 ring-[var(--border)]"
      title={agentTitle ?? undefined}
    >
      <AgentMark client={agent.client} label={agent.label} className="h-3.5 w-3.5" />
    </div>
  ) : null;
  if (person && bot) {
    return (
      <div className="flex shrink-0 items-center" aria-hidden="true">
        <div className="relative z-10 rounded-full ring-2 ring-[var(--panel)]">{person}</div>
        <div className="-ml-1.5">{bot}</div>
      </div>
    );
  }
  if (person) return <div className="shrink-0" aria-hidden="true">{person}</div>;
  if (bot) return <div className="shrink-0" aria-hidden="true">{bot}</div>;
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]" aria-hidden="true">
      ?
    </div>
  );
}

/** How a row enters: staggered page enter, the live-arrival highlight, or nothing (already shown). */
type RowEnter = "fresh" | "none";

function ActivityRow({ item, enter = "none" }: { item: ActivityItem; enter?: RowEnter }) {
  const docGone = item.type === "doc.deleted" || Boolean(item.doc?.deleted);
  const Icon = item.type === "doc.imported_url" && item.meta?.via === "bytes" ? ArrowUpTrayIcon : ICON_BY_TYPE[item.type] ?? ClockIcon;
  // Open the link the event came through (meta.shareId), not always the document's default link.
  const eventShareId = typeof item.meta?.shareId === "string" && item.meta.shareId ? item.meta.shareId : null;
  const shareId = eventShareId ?? item.doc?.shareId ?? null;
  const shareHref = shareId ? `/s/${encodeURIComponent(shareId)}` : null;
  /**
   * That link's own numbers, not the document's.
   *
   * The feed is where an owner finds out someone read the deck, and it already knows which link the
   * event came through (`meta.shareId`) — but the only control on the row opened the recipient's
   * view of the file. "Sequoia opened it" and "so how is the Sequoia link doing" is one thought,
   * and answering it meant leaving the feed, finding the document, opening its links table and
   * picking the row. Gone once the document is deleted: there is nothing left to scope to.
   */
  const linkMetricsHref =
    shareId && item.doc?.id && !docGone
      ? `/doc/${encodeURIComponent(item.doc.id)}/metrics?shareId=${encodeURIComponent(shareId)}`
      : null;
  const s = describeActivity(item);
  const when = formatRelative(item.createdDate);
  const exact = new Date(item.createdDate).toLocaleString();

  // On a `share_link.*` row the bold name is the LINK, so it goes to that link's own numbers.
  // It used to go to the document, which made the two halves of the sentence — the link and the
  // document it is on — lead to the same page, and left no way to reach the link itself.
  const isLinkRow = item.type.startsWith("share_link.");
  const href = (isLinkRow ? linkMetricsHref : null) ?? hrefFor(item);
  const docHref = item.doc?.id && !docGone ? `/doc/${encodeURIComponent(item.doc.id)}` : null;

  const linkClass = "font-semibold text-[var(--fg)] hover:underline underline-offset-4";
  const objectNode = s.object ? (
    href ? (
      <Link href={href} className={linkClass}>
        {s.object}
      </Link>
    ) : (
      <span className="font-semibold text-[var(--fg)]">{s.object}</span>
    )
  ) : null;

  // The document's title is the tail of the suffix ("for USAVX MEMO", "on Meridian Robotics"), and
  // `describeActivity` builds it from this same title, so the split is exact rather than a guess.
  // Only the title becomes a link; the preposition in front of it stays plain text.
  const docTitle = item.doc?.title?.trim() || "Untitled document";
  const suffixNode = (() => {
    if (!s.suffix) return null;
    if (s.object === docTitle || !s.suffix.endsWith(docTitle)) return <span>{s.suffix}</span>;
    const lead = s.suffix.slice(0, s.suffix.length - docTitle.length);
    return (
      <>
        {lead ? <span>{lead.trimEnd()}</span> : null}
        {docHref ? (
          <Link href={docHref} className={linkClass}>
            {docTitle}
          </Link>
        ) : (
          // A deleted document keeps the same bold object styling, just without the link.
          <span className="font-semibold text-[var(--fg)]">{docTitle}</span>
        )}
      </>
    );
  })();

  return (
    <li
      className={[
        // Grid wrapper: a live arrival animates grid-template-rows 0fr -> 1fr, so the rows below
        // slide down with it instead of jumping; the inner div clips during the expand.
        "grid",
        // Only a row that arrived live (a realtime frame while the page is open) animates: it expands
        // into place, holds a soft tint and fades back. Rows from a load, refresh, filter or page
        // change render still; a row that finished its highlight goes back to "none" without a blink.
        enter === "fresh" ? "motion-safe:animate-[ldFeedRowNew_7s_cubic-bezier(0.22,0.61,0.36,1)_both]" : "",
      ].join(" ")}
    >
      <div className="min-h-0 overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--panel-hover)] text-[var(--muted-2)] ring-1 ring-[var(--border)]">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <ActorAvatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-[var(--muted)]">
          <span className="font-medium text-[var(--fg)]">{s.subject}</span>
          <span>{s.verb}</span>
          {objectNode}
          {suffixNode}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
          <time dateTime={item.createdDate} title={exact}>
            {when}
          </time>
          {shareHref && !docGone && item.type !== "share_link.revoked" && item.type !== "doc.archived" ? (
            <>
              <span aria-hidden="true">·</span>
              <Link
                href={shareHref}
                className="hover:text-[var(--fg)] hover:underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                Share link
              </Link>
            </>
          ) : null}
          {/* Stays available on a revoked or archived link, unlike "Share link": the link no longer
              opens, and what it did while it was live is exactly what an owner wants at that point. */}
          {linkMetricsHref ? (
            <>
              <span aria-hidden="true">·</span>
              <Link href={linkMetricsHref} className="hover:text-[var(--fg)] hover:underline underline-offset-4">
                Analytics
              </Link>
            </>
          ) : null}
        </div>
      </div>
      </div>
      </div>
    </li>
  );
}

export default function ActivityPageClient() {
  const [filter, setFilter] = useState<ActivityFilterId>("all");
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  // Live arrivals: highlighted while fresh, then back to no animation. New rows are queued and
  // inserted one at a time, oldest first, so a burst reads as a sequence instead of a wall.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const freshTimersRef = useRef<number[]>([]);
  const arrivalQueueRef = useRef<ActivityItem[]>([]);
  const drainTimerRef = useRef<number | null>(null);
  const lastInsertAtRef = useRef(0);
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
  // cursors[i] is the cursor that opened page i (null for the first page); pageIndex points at the current page.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Changes on every page swap so rows remount and replay their enter animation.
  const [pageKey, setPageKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const types = useMemo(() => ACTIVITY_FILTERS.find((f) => f.id === filter)?.types ?? [], [filter]);
  // Second axis: who did it. "Teammates" is the team-activity story; on Free it opens the
  // collaborator upsell instead of filtering, since a Free workspace has no teammates to show.
  const [who, setWho] = useState<"all" | "me" | "team" | "agents">("all");
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

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<{ items: ActivityItem[]; nextCursor: string | null }> => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      if (types.length) params.set("type", types.join(","));
      if (who !== "all") params.set("who", who);
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
    [types, who, pageSize],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCursors([null]);
    setPageIndex(0);
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
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
  }, [fetchPage]);

  // Live-ish feed: while the tab is visible and on the first page, re-check every 10s (and on
  // focus) and swap in the new first page when anything changed. Polling stands in for the push
  // channel planned on the Node host (see docs/prds/lnkdrp-mcp.md, Future).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible" || pageIndex !== 0 || pending || loading) return;
      fetchPage(null)
        .then((page) => {
          setItems((prev) => {
            const changed = page.items.length !== prev.length || page.items.some((it, i) => it.id !== prev[i]?.id);
            if (!changed) return prev;
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
    const timer = window.setInterval(() => {
      if (realtimeState() === "open") return;
      tick();
    }, 10_000);
    window.addEventListener("focus", tick);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [fetchPage, pageIndex, pending, loading, drainArrivals]);

  /**
   * Page transition choreography: dim and lift the current rows, glide the feed to the top, fetch
   * the next page, then let the new rows fade up in a short stagger. Never blanks the list.
   */
  async function goToPage(index: number) {
    if (loading || pending) return;
    const cursor = index < cursors.length ? cursors[index] : nextCursor;
    if (index > 0 && !cursor) return;
    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setPending(true);
    setLeaving(true);
    setError(null);
    feedRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
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
  }

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: ActivityItem[] }[] = [];
    for (const item of items) {
      const key = dayKey(item.createdDate);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(item);
      else out.push({ key, label: dayLabel(key), items: [item] });
    }
    return out;
  }, [items]);

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
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Activity filters">
          {ACTIVITY_FILTERS.map((f) => {
            const active = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.id)}
                className={[
                  "h-8 rounded-full px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  active
                    ? "bg-[var(--fg)] text-[var(--bg)]"
                    : "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
              >
                {f.label}
              </button>
            );
          })}
        </div>

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
                className={[
                  "h-8 rounded-full px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  active
                    ? "bg-[var(--fg)] text-[var(--bg)]"
                    : "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
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

        {loading ? (
          <div className="grid gap-6" aria-hidden="true">
            <div className="mb-2 h-3 w-16 rounded bg-[var(--panel-hover)]" />
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
              <ul className="divide-y divide-[var(--border)]">
                {Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
                    <div className="h-8 w-8 rounded-full bg-[var(--panel-hover)]" />
                    <div className="min-w-0 flex-1">
                      <div className="h-3.5 w-[min(420px,70%)] rounded bg-[var(--panel-hover)]" />
                      <div className="mt-2 h-3 w-24 rounded bg-[var(--panel-hover)]" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : !items.length ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--muted)]">
            No activity yet. Uploads, share changes and views will show up here.
          </div>
        ) : (
          <div
            key={pageKey}
            className={[
              "grid gap-6 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              leaving ? "translate-y-1 opacity-40" : "translate-y-0 opacity-100",
            ].join(" ")}
          >
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                  {g.label}
                </div>
                {/* overflow-hidden: the live-arrival tint on the first/last row must clip to the card's corners. */}
                <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  <ul className="divide-y divide-[var(--border)]">
                    {g.items.map((item) => (
                      <ActivityRow key={item.id} item={item} enter={freshIds.has(item.id) ? "fresh" : "none"} />
                    ))}
                  </ul>
                </div>
              </section>
            ))}

            {(pageIndex > 0 || nextCursor || items.length >= pageSize) ? (
              <nav aria-label="Activity pages" className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="flex items-center gap-2 text-[12px] text-[var(--muted-2)]">
                  <span>Per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] text-[var(--fg)]"
                  >
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pageIndex === 0 || loading || pending}
                    onClick={() => void goToPage(pageIndex - 1)}
                    className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="min-w-[4.5rem] text-center text-[12px] tabular-nums text-[var(--muted-2)]" aria-live="polite">
                    {pending ? "Loading…" : `Page ${pageIndex + 1}`}
                  </span>
                  <button
                    type="button"
                    disabled={!nextCursor || loading || pending}
                    onClick={() => void goToPage(pageIndex + 1)}
                    className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
