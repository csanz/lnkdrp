"use client";

/**
 * Client UI for `/activity`.
 *
 * Renders the workspace activity feed grouped by day with type filters and Previous/Next paging
 * (cursor-based under the hood: the cursor that opened each page is kept so Previous can replay it).
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  GlobeAltIcon,
  InboxArrowDownIcon,
  LinkIcon,
  LockClosedIcon,
  LockOpenIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import PlanLimitNotice from "@/components/PlanLimitNotice";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { usePlan } from "@/lib/client/usePlan";
import { subscribeRealtime } from "@/lib/client/realtime";
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
/** Rows beyond this index enter together (stagger stops growing) so long pages never feel slow. */
const STAGGER_CAP = 14;

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const ICON_BY_TYPE: Record<string, HeroIcon> = {
  "doc.created": DocumentPlusIcon,
  "doc.imported_url": GlobeAltIcon,
  "upload.completed": ArrowUpTrayIcon,
  "doc.processed": CpuChipIcon,
  "doc.replaced": ArrowPathIcon,
  "doc.deleted": TrashIcon,
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
  if (item.doc?.id && item.type !== "doc.deleted") return `/doc/${encodeURIComponent(item.doc.id)}`;
  if (item.project?.id) return `/project/${encodeURIComponent(item.project.id)}`;
  return null;
}

function ActorAvatar({ item }: { item: ActivityItem }) {
  const name = actorDisplayName(item.actor);
  const label = name ?? (item.agent?.label || null);
  const initials = label ? initialsFromNameOrEmail(label) : "?";
  return (
    <div
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]"
      title={item.actor.email ?? label ?? undefined}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function ActivityRow({ item, index = 0 }: { item: ActivityItem; index?: number }) {
  const Icon = ICON_BY_TYPE[item.type] ?? ClockIcon;
  const s = describeActivity(item);
  const href = hrefFor(item);
  const when = formatRelative(item.createdDate);
  const exact = new Date(item.createdDate).toLocaleString();

  const objectNode = s.object ? (
    href ? (
      <Link href={href} className="font-semibold text-[var(--fg)] hover:underline underline-offset-4">
        {s.object}
      </Link>
    ) : (
      <span className="font-semibold text-[var(--fg)]">{s.object}</span>
    )
  ) : null;

  return (
    <li style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * 28}ms` }} className="motion-safe:animate-[ldFeedRowIn_360ms_cubic-bezier(0.2,0.7,0.2,1)_both] flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--panel-hover)] text-[var(--muted-2)] ring-1 ring-[var(--border)]">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <ActorAvatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-[var(--muted)]">
          <span className="font-medium text-[var(--fg)]">{s.subject}</span>
          <span>{s.verb}</span>
          {objectNode}
          {s.suffix ? <span>{s.suffix}</span> : null}
          {item.agent ? (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-[var(--panel-hover)] px-1.5 py-0 text-[10px] font-medium text-[var(--muted)] ring-1 ring-[var(--border)]"
              title={item.agent.version ? `${item.agent.label} ${item.agent.version}` : item.agent.label}
            >
              <CpuChipIcon className="h-3 w-3" aria-hidden="true" />
              {item.agent.label}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
          <time dateTime={item.createdDate} title={exact}>
            {when}
          </time>
          {item.doc?.shareId && item.type !== "doc.deleted" ? (
            <>
              <span aria-hidden="true">·</span>
              <Link
                href={`/s/${encodeURIComponent(item.doc.shareId)}`}
                className="hover:text-[var(--fg)] hover:underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                Share link
              </Link>
            </>
          ) : null}
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
  const { plan } = usePlan();
  const isFree = plan?.plan === "free";
  const { openUpgrade } = useUpgradeModal();
  const [teamNudgeDismissed, setTeamNudgeDismissed] = useState(false);

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
            return changed ? page.items : prev;
          });
          setNextCursor(page.nextCursor);
        })
        .catch(() => {
          // Background refresh; the visible feed stays as it was.
        });
    };
    // Push: a new activity row in this workspace arrives as an "activity" frame; refetch page one
    // right away. The 10s timer stays as the fallback when the socket is not available.
    const unsubscribe = subscribeRealtime("activity", () => tick());
    const timer = window.setInterval(tick, 10_000);
    window.addEventListener("focus", tick);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [fetchPage, pageIndex, pending, loading]);

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
      <div className="border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <div className="flex items-center gap-2">
          <ClockIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
          <div className="text-sm font-semibold text-[var(--fg)]">Activity</div>
        </div>
        <div className="mt-1 text-xs text-[var(--muted-2)]">
          Uploads, share changes, views and agent activity in this workspace, by everyone in it.
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Activity filters">
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

        <div className="mt-2 flex flex-wrap items-center gap-2" role="tablist" aria-label="Who did it">
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
                  "h-7 rounded-full px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
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

      <div ref={feedRef} className="relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] px-6 py-6" aria-busy={pending || loading}>
        {isFree && !teamNudgeDismissed ? (
          <PlanLimitNotice
            limit="collaborators"
            compact
            className="mb-4"
            secondaryLabel="Compare plans"
            secondaryHref="/pricing"
            onDismiss={() => setTeamNudgeDismissed(true)}
          />
        ) : null}
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-6 -mt-6 mb-4 h-0.5 overflow-hidden bg-transparent">
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
            {(() => { let i = 0; return groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                  {g.label}
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  <ul className="divide-y divide-[var(--border)]">
                    {g.items.map((item) => (
                      <ActivityRow key={item.id} item={item} index={i++} />
                    ))}
                  </ul>
                </div>
              </section>
            )); })()}

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
