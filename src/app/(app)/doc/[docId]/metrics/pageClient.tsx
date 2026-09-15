/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 */
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronDownIcon, LockClosedIcon, UserIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import Button from "@/components/ui/Button";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { usePlan } from "@/lib/client/usePlan";
import { Area, AreaChart, CartesianGrid, Tooltip, YAxis } from "recharts";

/** Free = basic (totals, chart, unique viewer count); Pro = deep (identities, per-page time, visits). */
type AnalyticsTier = "basic" | "deep";

type MetricsResponse = {
  ok: true;
  docTitle?: string;
  days: number;
  /** Present when the workspace plan clamps the analytics window (Free = 7 days). */
  analyticsDaysLimit?: number;
  /** Which tier the server rendered; on `"basic"` the viewer arrays are empty and per-page maps are omitted. */
  analyticsTier?: AnalyticsTier;
  /** Unique viewers (signed-in + anonymous) inside the window; the only per-viewer fact Free receives. */
  viewerCount?: number;
  totals: {
    views: number;
    /** Tab sessions in the window: the count of *opens*, where `views` counts recipients. */
    opens?: number;
    /** `opens` is missing rows for older traffic; the figure is a floor, not a count. */
    opensPartial?: boolean;
    /** Absent on a `?viewersOnly=1` response, which never computes it — see the route header. */
    downloads?: number;
    pagesViewed: number;
    authenticatedViewers: number;
    anonymousViewers?: number;
  };
  downloadsEnabled?: boolean;
  /**
   * `?byLink=1`: the same window, per link slug — including slugs whose link has since been
   * deleted, which `GET /api/docs/:docId/links` does not return. `sum(views)` equals
   * `totals.views` and `sum(downloads)` equals `totals.downloads`, so the table reconciles with
   * the cards above it.
   */
  byLink?: Array<{
    shareId: string;
    views: number;
    viewers: number;
    opens?: number;
    downloads: number;
    pagesViewed: number;
    lastViewedAt: string | null;
  }>;
  /** Absent on a `?viewersOnly=1` response. */
  series?: Array<{ date: string; views: number; downloads: number }>;
  viewers: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    views: number;
    timeSpentMs?: number;
    pageTimeMsByPage?: Record<string, number>;
    pagesViewed?: number;
    pagesSeen?: number[];
    firstSeen: string | null;
    lastSeen: string | null;
  }>;
  anonymousViewers?: Array<{
    botIdHash: string;
    name?: string | null;
    email?: string | null;
    views: number;
    timeSpentMs?: number;
    pageTimeMsByPage?: Record<string, number>;
    pagesViewed?: number;
    pagesSeen?: number[];
    firstSeen: string | null;
    lastSeen: string | null;
  }>;
};

/** The `ShareLinkDTO` fields this page renders (`GET /api/docs/:docId/links`). */
type ShareLinkRow = {
  id: string;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  status: "active" | "disabled" | "expired" | "archived";
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
};

/** One link's totals inside the selected window (from `/shareviews?shareId=…&lite=1`). */
type LinkWindowStats = { views: number; downloads: number; viewers: number; opens: number; lastViewedAt: string | null };

type ShareViewerVisitSummary = {
  visitId: string;
  startedAt: string | null;
  lastEventAt: string | null;
  timeSpentMs: number;
  pagesSeen: number[];
  pageTimeMsByPage?: Record<string, number>;
  pageVisitCountByPage?: Record<string, number>;
};

type ShareViewerVisitsResponse = {
  ok: true;
  docId: string;
  kind: "authed" | "anon";
  visits: ShareViewerVisitSummary[];
};

type ShareViewerVisitDetailResponse = {
  ok: true;
  docId: string;
  visit: {
    visitId: string;
    shareId: string | null;
    startedAt: string | null;
    lastEventAt: string | null;
    timeSpentMs: number;
    pagesSeen: number[];
    revisitedPages: number[];
    pageTimeMsByPage: Record<string, number>;
    pageVisitCountByPage: Record<string, number>;
    events: Array<{ pageNumber: number; enteredAt: string | null; leftAt: string | null; durationMs: number }>;
  };
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function formatShortId(id: string | null | undefined, { head = 4, tail = 4 }: { head?: number; tail?: number } = {}): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return "";
  if (raw.length <= head + tail + 1) return raw;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
}

function formatPageRanges(pages: number[]): string {
  const sorted = Array.from(new Set(pages.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 1)))
    .map((n) => Math.floor(n))
    .sort((a, b) => a - b);
  if (!sorted.length) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  parts.push(start === prev ? String(start) : `${start}–${prev}`);
  return parts.join(", ");
}

function formatDayLabel(isoDay: string | null): string {
  if (!isoDay) return "";
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return isoDay;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function formatDurationShort(msRaw: number | null | undefined): string {
  const ms = typeof msRaw === "number" && Number.isFinite(msRaw) ? Math.max(0, Math.floor(msRaw)) : 0;
  if (ms <= 0) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDurationTiny(msRaw: number | null | undefined): string {
  const ms = typeof msRaw === "number" && Number.isFinite(msRaw) ? Math.max(0, Math.floor(msRaw)) : 0;
  if (ms <= 0) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours}h`;
}

function MiniLineChartSingle({
  series,
  values,
  stroke,
  fillId,
  fillStops,
}: {
  series: Array<{ date: string }>;
  values: number[];
  stroke: string;
  fillId: string;
  fillStops: { topOpacity: number; bottomOpacity: number };
}) {
  const safeValues = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0));
  const data = series.map((s, idx) => ({ date: s.date, value: safeValues[idx] ?? 0 }));
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    function update() {
      const current = wrapRef.current;
      if (!current) return;
      const r = current.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w > 0 && h > 0) setSize({ w, h });
    }

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="w-full">
      <div ref={wrapRef} className="h-56 w-full">
        {!size ? null : (
          <AreaChart width={size.w} height={size.h} data={data} margin={{ top: 6, right: 6, bottom: 4, left: 6 }}>
            <defs>
              <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={fillStops.topOpacity} />
                <stop offset="100%" stopColor={stroke} stopOpacity={fillStops.bottomOpacity} />
              </linearGradient>
            </defs>

            <YAxis hide domain={[0, "dataMax"]} />
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
            <Tooltip
              cursor={{ stroke: "var(--border)", strokeOpacity: 0.25 }}
              contentStyle={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "8px 10px",
                fontSize: 12,
                color: "var(--fg)",
              }}
              labelStyle={{ color: "var(--muted-2)" }}
              formatter={(v: any) => [typeof v === "number" ? v.toLocaleString() : String(v), ""]}
              labelFormatter={(label: any) => String(label ?? "")}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={stroke}
              strokeWidth={1.15}
              fill={`url(#${fillId})`}
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 2.25, strokeWidth: 1.15 }}
              isAnimationActive={false}
            />
          </AreaChart>
        )}
      </div>

      <div
        className="mt-3 grid gap-0 text-[10px] text-[var(--muted)]"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, series.length)}, minmax(0, 1fr))` }}
      >
        {series.map((s) => (
          <div key={`tick:${s.date}`} className="px-1 text-center tabular-nums">
            {formatDayLabel(s.date)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="text-[var(--muted-2)]">
      <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="text-[var(--muted-2)]">
      <path d="M16 6l-7 8-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** Placeholder row widths (name / email / views / last-seen) so the blurred list reads as real data. */
const LOCKED_ROW_WIDTHS: ReadonlyArray<[string, string, string, string]> = [
  ["w-40", "w-56", "w-24", "w-32"],
  ["w-32", "w-48", "w-20", "w-32"],
  ["w-44", "w-52", "w-24", "w-28"],
];

/**
 * Free-tier stand-in for the viewer lists: the unique viewer count, three blurred placeholder rows
 * and a quiet Pro prompt whose button opens the `analytics_history` upsell. `pending` reserves the
 * same footprint (plain skeleton, no prompt) while the plan snapshot is still loading, so the page
 * does not jump once it resolves.
 */
/**
 * Pick one link to scope the page to, from a list that may be long.
 *
 * Replaces a row of pills. Pills read well at three links, wrap at twelve and are unusable at a
 * hundred — and a document is allowed a hundred: one link per investor is the feature. A picker
 * costs one click and stays the same size whatever the count, with a filter box that appears only
 * when there are enough links to need it.
 *
 * Each row carries the link's viewers, because choosing between "Sequoia" and "Benchmark" without
 * knowing which one anybody opened is choosing blind — the same reason the table below exists.
 */
function LinkPicker({
  links,
  shareId,
  stats,
  onSelect,
  open,
  setOpen,
}: {
  links: ShareLinkRow[];
  shareId: string | null;
  stats: Record<string, LinkWindowStats>;
  onSelect: (next: string | null) => void;
  open: boolean;
  setOpen: (next: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = shareId ? links.find((l) => l.shareId === shareId) ?? null : null;
  const needsFilter = links.length > 8;
  const q = query.trim().toLowerCase();
  const shown = q
    ? links.filter((l) => l.label.toLowerCase().includes(q) || (l.audience ?? "").toLowerCase().includes(q))
    : links;

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex max-w-[320px] items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
      >
        <span className="truncate">{selected ? selected.label : "All links"}</span>
        <span className="shrink-0 text-[var(--muted-2)]">{links.length}</span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
      </button>

      {open ? (
        <>
          {/* Click-away, behind the menu: a picker that only closes by re-clicking its own button
              feels stuck when the page behind it is what you meant to get back to. */}
          <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            className="absolute left-0 z-20 mt-1 max-h-[22rem] w-[22rem] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
          >
            {needsFilter ? (
              <div className="border-b border-[var(--border)] p-2">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter links"
                  aria-label="Filter links"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1.5 text-[13px] text-[var(--fg)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>
            ) : null}
            <div className="max-h-[18rem] overflow-y-auto p-1">
              <button
                type="button"
                role="option"
                aria-selected={!shareId}
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
                className={[
                  "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]",
                  !shareId ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
                ].join(" ")}
              >
                <span className="font-medium">All links</span>
                <span className="text-[11px] text-[var(--muted-2)]">the whole document</span>
              </button>
              {shown.map((l) => {
                const active = shareId === l.shareId;
                const s = stats[l.id];
                return (
                  <button
                    key={l.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onSelect(l.shareId);
                      setOpen(false);
                    }}
                    className={[
                      "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]",
                      active ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
                    ].join(" ")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{l.label}</span>
                      {l.audience ? <span className="block truncate text-[11px] text-[var(--muted-2)]">{l.audience}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted)]">
                      {s ? `${s.viewers} ${s.viewers === 1 ? "viewer" : "viewers"}` : "—"}
                    </span>
                  </button>
                );
              })}
              {!shown.length ? <div className="px-2.5 py-3 text-[13px] text-[var(--muted-2)]">No link matches that.</div> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function LockedViewersBlock({
  pending,
  loading,
  count,
  days,
  linkLabel,
  onUpgrade,
}: {
  pending: boolean;
  loading: boolean;
  count: number;
  days: number;
  /** The selected link, when the page is filtered — the count is that link's, not the document's. */
  linkLabel: string | null;
  onUpgrade: () => void;
}) {
  // This is the only viewer information a Free workspace gets, so it must name what it counted:
  // under a link filter, "no one has viewed this document" is a false statement about the document.
  const subject = linkLabel ?? "this document";
  const countLine =
    count <= 0
      ? `No one has opened ${subject} in the last ${days} days.`
      : count === 1
        ? `1 person opened ${subject} in the last ${days} days.`
        : `${count.toLocaleString()} people opened ${subject} in the last ${days} days.`;

  return (
    <section className="mt-1" aria-label="Viewers" aria-busy={pending || loading}>
      <div className="text-sm font-semibold text-[var(--fg)]">Viewers</div>
      {pending || loading ? (
        <div className="mt-1.5 h-4 w-64 rounded bg-[var(--panel-hover)] motion-safe:animate-pulse" aria-hidden="true" />
      ) : (
        <div className="mt-1 text-sm text-[var(--muted)]">{countLine}</div>
      )}

      <div className="relative mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
        <ul
          aria-hidden="true"
          className={[
            "divide-y divide-[var(--border)]",
            pending ? "motion-safe:animate-pulse" : "select-none blur-[3px]",
          ].join(" ")}
        >
          {LOCKED_ROW_WIDTHS.map(([name, email, views, seen], idx) => (
            <li key={`locked:${idx}`} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4">
              <div className="min-w-0">
                <div className={`h-4 max-w-full rounded bg-[var(--panel-hover)] ${name}`} />
                <div className={`mt-1.5 h-3 max-w-full rounded bg-[var(--panel-hover)] ${email}`} />
              </div>
              <div className="shrink-0">
                <div className={`h-3 rounded bg-[var(--panel-hover)] sm:ml-auto ${views}`} />
                <div className={`mt-1.5 h-3 rounded bg-[var(--panel-hover)] sm:ml-auto ${seen}`} />
              </div>
            </li>
          ))}
        </ul>

        {pending ? null : (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-center shadow-lg">
              <LockClosedIcon className="mx-auto h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
              <p className="mt-2 text-sm text-[var(--muted)]">
                See who they are, how long they spent on each page, and the full history on Pro
              </p>
              <Button variant="solid" size="sm" className="mt-3" onClick={onUpgrade}>
                Upgrade
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Render the MetricsPageClient UI (uses effects, local state).
 *
 * Free workspaces get the basic tier: totals, the views-by-day charts and the unique viewer
 * count, with the viewer lists replaced by `LockedViewersBlock`. The visits endpoints answer
 * `402` on Free, so they are never requested unless the tier is deep.
 */
export default function MetricsPageClient({ docId }: { docId: string }) {
  const router = useRouter();
  const [docTitle, setDocTitle] = useState<string>("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [viewersLoading, setViewersLoading] = useState(false);
  const [viewersLoaded, setViewersLoaded] = useState(false);
  const [authedViewersModalOpen, setAuthedViewersModalOpen] = useState(false);
  const [anonViewersModalOpen, setAnonViewersModalOpen] = useState(false);
  const [authedViewersModalPage, setAuthedViewersModalPage] = useState(0);
  const [anonViewersModalPage, setAnonViewersModalPage] = useState(0);
  const [days, setDays] = useState(15);
  const [rangeOpen, setRangeOpen] = useState(false);
  /** The link picker that replaced the chip row; see `LinkPicker`. */
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  // Links of this document: the chip row filters every figure on the page through `?shareId=`,
  // and the per-link table below compares them (docs/prds/lnkdrp-multi-links.md).
  const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
  // The selected link lives in the URL, not only in React state. A per-link view is a thing people
  // want to keep and pass on — "here is what Sequoia actually read" — and while it was state alone
  // it could not be bookmarked, reloaded, or linked to from the links table that shows the very
  // numbers it explains. `selectLink` is the only writer, so the two can never disagree.
  const searchParams = useSearchParams();
  const shareId = searchParams.get("shareId")?.trim() || null;

  function selectLink(next: string | null): void {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("shareId", next);
    else params.delete("shareId");
    const qs = params.toString();
    // `replace`, not `push`: flipping between links is refining one view, not walking a history
    // someone wants to step back through one chip at a time.
    router.replace(qs ? `?${qs}` : `/doc/${encodeURIComponent(docId)}/metrics`, { scroll: false });
  }
  /** Set when a filtered request 404s because the link was deleted elsewhere; the scope then resets. */
  const [filterDroppedNotice, setFilterDroppedNotice] = useState(false);
  /** `&shareId=…` for the selected link, or "" for "All links". */
  const linkFilterParam = shareId ? `&shareId=${encodeURIComponent(shareId)}` : "";
  const rangeLabel = useMemo(() => `Last ${days} days`, [days]);
  const { openUpgrade } = useUpgradeModal();
  const { plan } = usePlan();
  // The response is authoritative (Free gets `analyticsTier: "basic"`); the plan snapshot answers
  // before it lands. `null` until either arrives, which keeps the viewer block reserved.
  const analyticsTier: AnalyticsTier | null =
    data?.analyticsTier === "basic" || data?.analyticsTier === "deep"
      ? data.analyticsTier
      : plan
        ? plan.plan === "free"
          ? "basic"
          : "deep"
        : null;
  const deepAnalytics = analyticsTier === "deep";
  // Free workspaces are clamped server-side; the response says so and the picker follows.
  const analyticsDaysLimit =
    typeof data?.analyticsDaysLimit === "number" && Number.isFinite(data.analyticsDaysLimit) && data.analyticsDaysLimit > 0
      ? Math.floor(data.analyticsDaysLimit)
      : null;
  const rangeOptions = useMemo(
    () =>
      [
        { label: "Last 3 days", value: 3 },
        { label: "Last 7 days", value: 7 },
        { label: "Last 15 days", value: 15 },
        { label: "Last 30 days", value: 30 },
      ].filter((opt) => analyticsDaysLimit === null || opt.value <= analyticsDaysLimit),
    [analyticsDaysLimit],
  );

  useEffect(() => {
    // Snap the selected range to the plan window so the label and the data agree.
    if (analyticsDaysLimit !== null && days > analyticsDaysLimit) setDays(analyticsDaysLimit);
  }, [analyticsDaysLimit, days]);
  const [viewerDetail, setViewerDetail] = useState<
    | null
    | {
        kind: "authed" | "anon";
        key: string;
        title: string;
        subtitle?: string;
        views: number;
        pagesViewed: number;
        pagesSeen: number[];
        timeSpentMs: number;
        timeOpenMs: number;
        pageTimeMsByPage: Record<string, number>;
        firstSeen: string | null;
        lastSeen: string | null;
      }
  >(null);

  const [visitsModalOpen, setVisitsModalOpen] = useState(false);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [visitsError, setVisitsError] = useState<string | null>(null);
  const [visits, setVisits] = useState<ShareViewerVisitSummary[]>([]);
  const [visitDetail, setVisitDetail] = useState<ShareViewerVisitDetailResponse["visit"] | null>(null);
  const [visitDetailLoading, setVisitDetailLoading] = useState(false);
  const [visitDetailError, setVisitDetailError] = useState<string | null>(null);

  const viewerTimeTotalMs = viewerDetail ? (viewerDetail.timeSpentMs > 0 ? viewerDetail.timeSpentMs : viewerDetail.timeOpenMs) : 0;
  const viewerTimeApproxPrefix = viewerDetail ? (viewerDetail.timeSpentMs > 0 ? "" : "~") : "";
  const viewerAvgTimeMs =
    viewerDetail && viewerTimeTotalMs > 0 ? Math.round(viewerTimeTotalMs / Math.max(1, viewerDetail.views)) : 0;
  const viewerAvgPageMs =
    viewerDetail && viewerTimeTotalMs > 0
      ? Math.round(viewerTimeTotalMs / Math.max(1, viewerDetail.pagesViewed || viewerDetail.pagesSeen.length || 1))
      : 0;
  const viewerHasRealPerPageTime =
    viewerDetail ? Object.values(viewerDetail.pageTimeMsByPage ?? {}).some((v) => typeof v === "number" && Number.isFinite(v) && v > 0) : false;
  const viewerTrackedTimeTotalMs = viewerDetail ? viewerDetail.timeSpentMs : 0;
  const viewerTrackedAvgPerViewMs =
    viewerDetail && viewerDetail.timeSpentMs > 0 ? Math.round(viewerDetail.timeSpentMs / Math.max(1, viewerDetail.views)) : 0;
  const viewerTrackedAvgPerPageMs =
    viewerDetail && viewerDetail.timeSpentMs > 0
      ? Math.round(viewerDetail.timeSpentMs / Math.max(1, viewerDetail.pagesViewed || viewerDetail.pagesSeen.length || 1))
      : 0;

  const VIEWERS_PAGE_SIZE = 25;

  // Doc title now comes back as part of /shareviews to avoid an extra API call on load.

  useEffect(() => {
    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setRangeOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setRangeOpen(false);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadMetrics() {
      setLoading(true);
      setError(null);
      setViewersLoading(false);
      setViewersLoaded(false);
      try {
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&lite=1&byLink=1${linkFilterParam}`,
          { cache: "no-store" },
        );
        if (res.status === 404) {
          // A filtered request 404s when that link is gone (deleted elsewhere): drop the filter
          // rather than treating it as a missing document — and say so, because otherwise every
          // number on the page silently grows into the document's totals while the reader still
          // believes they are looking at one link.
          if (linkFilterParam) {
            if (!cancelled) {
              selectLink(null);
              setFilterDroppedNotice(true);
            }
            return;
          }
          if (!cancelled) router.replace("/dashboard");
          return;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Request failed (${res.status})`);
        }
        const json = (await res.json()) as unknown;
        if (cancelled) return;
        if (!json || typeof json !== "object" || !(json as { ok?: unknown }).ok) {
          throw new Error("Invalid response");
        }
        const parsed = json as MetricsResponse;
        setData(parsed);
        const t = typeof parsed?.docTitle === "string" ? parsed.docTitle.trim() : "";
        if (!cancelled && t) setDocTitle(t);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load metrics");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadMetrics();
    return () => {
      cancelled = true;
    };
  }, [docId, days, linkFilterParam, router]);

  // Auto-load the viewers list after the lightweight payload returns (no button). Basic tier gets
  // no identities back, so the request is skipped entirely there.
  useEffect(() => {
    if (!data?.ok || !deepAnalytics) return;
    if (viewersLoading || viewersLoaded) return;
    let cancelled = false;
    setViewersLoading(true);
    void (async () => {
      try {
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&viewers=1&viewersOnly=1${linkFilterParam}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as any;
        if (cancelled) return;
        if (!json || typeof json !== "object" || json.ok !== true) return;
        setData((prev) => {
          if (!prev || typeof prev !== "object") return prev as any;
          const next = { ...(prev as any) };
          next.totals = {
            ...(prev as any).totals,
            authenticatedViewers:
              typeof json?.totals?.authenticatedViewers === "number"
                ? json.totals.authenticatedViewers
                : (prev as any)?.totals?.authenticatedViewers ?? 0,
            anonymousViewers:
              typeof json?.totals?.anonymousViewers === "number"
                ? json.totals.anonymousViewers
                : (prev as any)?.totals?.anonymousViewers ?? 0,
          };
          next.viewers = Array.isArray(json.viewers) ? json.viewers : [];
          next.anonymousViewers = Array.isArray(json.anonymousViewers) ? json.anonymousViewers : [];
          return next as MetricsResponse;
        });
        setViewersLoaded(true);
      } finally {
        if (!cancelled) setViewersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `data` (not `data.ok`) is the trigger: a new payload — a new range, or a different link
    // filter — always arrives with `viewersLoaded` reset, so the viewer list follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, days, linkFilterParam, data, deepAnalytics]);

  // The links of this document, for the filter chips and the per-link table.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/links`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { links?: ShareLinkRow[] };
        if (!cancelled && Array.isArray(json?.links)) setLinks(json.links);
      } catch {
        // the page works without the link breakdown
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Per-link totals for the window, derived from the page's own response (`?byLink=1`) instead of
  // one request per link. Grouped server-side by slug over the same rows as the cards above, so the
  // rows add up to the header — and nothing is capped, so a link that sorts last no longer reads
  // as dead just because its request was never made.
  /** The label of the selected link, for copy that must not say "this document" under a filter. */
  const selectedLinkLabel = useMemo(
    () => (shareId ? ((links ?? []).find((l) => l.shareId === shareId)?.label ?? "this link") : null),
    [shareId, links],
  );

  const linkStats = useMemo(() => {
    const next: Record<string, LinkWindowStats> = {};
    if (!links || !data?.byLink) return next;
    const bySlug = new Map(data.byLink.map((r) => [r.shareId, r]));
    for (const l of links) {
      const row = bySlug.get(l.shareId);
      next[l.id] = {
        views: Math.max(0, Math.floor(row?.views ?? 0)),
        downloads: Math.max(0, Math.floor(row?.downloads ?? 0)),
        viewers: Math.max(0, Math.floor(row?.viewers ?? 0)),
        opens: Math.max(0, Math.floor(row?.opens ?? 0)),
        lastViewedAt: typeof row?.lastViewedAt === "string" ? row.lastViewedAt : null,
      };
    }
    return next;
  }, [links, data]);

  /**
   * Views and downloads recorded on slugs the table cannot show: links that were deleted (their
   * rows stay in the document total by design) and any slug the links endpoint omits. Rendered as
   * its own row so the column reconciles with the "All links" card instead of quietly falling short.
   */
  const deletedLinkResidual = useMemo(() => {
    if (!links || !data?.byLink) return null;
    const known = new Set(links.map((l) => l.shareId));
    const rest = data.byLink.filter((r) => !known.has(r.shareId));
    if (!rest.length) return null;
    const views = rest.reduce((a, r) => a + Math.max(0, Math.floor(r.views ?? 0)), 0);
    const downloads = rest.reduce((a, r) => a + Math.max(0, Math.floor(r.downloads ?? 0)), 0);
    const viewers = rest.reduce((a, r) => a + Math.max(0, Math.floor(r.viewers ?? 0)), 0);
    const opens = rest.reduce((a, r) => a + Math.max(0, Math.floor(r.opens ?? 0)), 0);
    if (!views && !downloads) return null;
    return { count: rest.length, views, downloads, viewers, opens };
  }, [links, data]);

  const views = data?.totals?.views ?? 0;
  /** Tab sessions in the window: opens, not recipients. `null` on a response from before it existed. */
  const opens =
    typeof data?.totals?.opens === "number" && data.totals.opensPartial !== true
      ? Math.max(0, Math.floor(data.totals.opens))
      : null;
  const downloads = data?.totals?.downloads ?? 0;
  // `totals.downloads` is omitted by viewers-only responses: undefined means "not loaded", not zero.
  const downloadsKnown = typeof data?.totals?.downloads === "number";
  const pagesViewed = data?.totals?.pagesViewed ?? 0;
  const authedViewers = data?.totals?.authenticatedViewers ?? 0;
  const anonViewers = data?.totals?.anonymousViewers ?? 0;
  // Unique people in the window; the basic tier's only per-viewer fact. Older responses lack it.
  const viewerCount =
    typeof data?.viewerCount === "number" && Number.isFinite(data.viewerCount)
      ? Math.max(0, Math.floor(data.viewerCount))
      : authedViewers + anonViewers;
  const downloadsEnabled = Boolean(data?.downloadsEnabled);
  const series = Array.isArray(data?.series) ? data!.series : [];
  const hasData = Boolean(data && data.ok);
  const anonymousViewersList = Array.isArray(data?.anonymousViewers) ? data!.anonymousViewers : [];
  const chartSeries = series.map((s) => ({ date: s.date }));
  const viewsSeries = series.map((s) => (typeof s.views === "number" && Number.isFinite(s.views) ? s.views : 0));
  const downloadsSeries = series.map((s) =>
    typeof s.downloads === "number" && Number.isFinite(s.downloads) ? s.downloads : 0,
  );

  const authedViewersList = Array.isArray(data?.viewers) ? data!.viewers : [];
  const authedViewersTop = authedViewersList.slice(0, 5);
  const anonViewersTop = anonymousViewersList.slice(0, 5);

  const authedModalTotal = authedViewersList.length;
  const authedModalPages = Math.max(1, Math.ceil(authedModalTotal / VIEWERS_PAGE_SIZE));
  const authedModalPageSafe = Math.min(Math.max(0, authedViewersModalPage), authedModalPages - 1);
  const authedModalStart = authedModalTotal ? authedModalPageSafe * VIEWERS_PAGE_SIZE : 0;
  const authedModalEnd = authedModalTotal ? Math.min(authedModalStart + VIEWERS_PAGE_SIZE, authedModalTotal) : 0;
  const authedModalItems = authedViewersList.slice(authedModalStart, authedModalEnd);

  const anonModalTotal = anonymousViewersList.length;
  const anonModalPages = Math.max(1, Math.ceil(anonModalTotal / VIEWERS_PAGE_SIZE));
  const anonModalPageSafe = Math.min(Math.max(0, anonViewersModalPage), anonModalPages - 1);
  const anonModalStart = anonModalTotal ? anonModalPageSafe * VIEWERS_PAGE_SIZE : 0;
  const anonModalEnd = anonModalTotal ? Math.min(anonModalStart + VIEWERS_PAGE_SIZE, anonModalTotal) : 0;
  const anonModalItems = anonymousViewersList.slice(anonModalStart, anonModalEnd);

  function openAuthedViewerDetail(v: MetricsResponse["viewers"][number]) {
    const name = typeof v.name === "string" ? v.name.trim() : "";
    const email = typeof v.email === "string" ? v.email.trim() : "";
    const title = name || email || "Signed-in user";
    const shortId = formatShortId(v.userId);
    const subtitle = name && email ? email : !email && shortId ? `User ID ${shortId}` : undefined;
    const pagesSeen = Array.isArray(v.pagesSeen)
      ? v.pagesSeen
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1)
          .map((n) => Math.floor(n))
          .sort((a, b) => a - b)
      : [];
    const pagesViewed =
      typeof v.pagesViewed === "number" && Number.isFinite(v.pagesViewed) ? Math.max(0, Math.floor(v.pagesViewed)) : pagesSeen.length;
    const timeSpentMs =
      typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) ? Math.max(0, Math.floor(v.timeSpentMs)) : 0;
    const firstSeenIso = v.firstSeen ?? null;
    const lastSeenIso = v.lastSeen ?? null;
    const firstMs = parseIsoMs(firstSeenIso);
    const lastMs = parseIsoMs(lastSeenIso);
    const timeOpenMs =
      timeSpentMs > 0 || firstMs === null || lastMs === null ? 0 : Math.max(0, Math.min(24 * 60 * 60 * 1000, lastMs - firstMs));
    const pageTimeMsByPage =
      v.pageTimeMsByPage && typeof v.pageTimeMsByPage === "object" ? (v.pageTimeMsByPage as Record<string, number>) : {};
    setViewerDetail({
      kind: "authed",
      key: v.userId,
      title,
      subtitle,
      views: typeof v.views === "number" && Number.isFinite(v.views) ? Math.max(0, Math.floor(v.views)) : 0,
      pagesViewed,
      pagesSeen,
      timeSpentMs,
      timeOpenMs,
      pageTimeMsByPage,
      firstSeen: firstSeenIso,
      lastSeen: lastSeenIso,
    });
  }

  function openAnonViewerDetail(v: NonNullable<MetricsResponse["anonymousViewers"]>[number]) {
    const botIdHash = typeof v.botIdHash === "string" ? v.botIdHash : "";
    const shortId = formatShortId(botIdHash);
    const name = typeof (v as any).name === "string" ? String((v as any).name).trim() : "";
    const email = typeof (v as any).email === "string" ? String((v as any).email).trim() : "";
    const title = name || email || "Anonymous viewer";
    const subtitle = name && email ? email : shortId ? `Device ${shortId}` : undefined;
    const pagesSeen = Array.isArray(v.pagesSeen)
      ? v.pagesSeen
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1)
          .map((n) => Math.floor(n))
          .sort((a, b) => a - b)
      : [];
    const pagesViewed =
      typeof v.pagesViewed === "number" && Number.isFinite(v.pagesViewed) ? Math.max(0, Math.floor(v.pagesViewed)) : pagesSeen.length;
    const timeSpentMs =
      typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) ? Math.max(0, Math.floor(v.timeSpentMs)) : 0;
    const firstSeenIso = v.firstSeen ?? null;
    const lastSeenIso = v.lastSeen ?? null;
    const firstMs = parseIsoMs(firstSeenIso);
    const lastMs = parseIsoMs(lastSeenIso);
    const timeOpenMs =
      timeSpentMs > 0 || firstMs === null || lastMs === null ? 0 : Math.max(0, Math.min(24 * 60 * 60 * 1000, lastMs - firstMs));
    const pageTimeMsByPage =
      v.pageTimeMsByPage && typeof v.pageTimeMsByPage === "object" ? (v.pageTimeMsByPage as Record<string, number>) : {};
    setViewerDetail({
      kind: "anon",
      key: botIdHash || "anon",
      title,
      subtitle,
      views: typeof v.views === "number" && Number.isFinite(v.views) ? Math.max(0, Math.floor(v.views)) : 0,
      pagesViewed,
      pagesSeen,
      timeSpentMs,
      timeOpenMs,
      pageTimeMsByPage,
      firstSeen: firstSeenIso,
      lastSeen: lastSeenIso,
    });
  }

  function countRevisitedPages(visit: ShareViewerVisitSummary): number {
    const m = visit.pageVisitCountByPage ?? {};
    return (visit.pagesSeen ?? []).reduce((acc, p) => {
      const c = m[String(p)];
      return acc + (typeof c === "number" && Number.isFinite(c) && c >= 2 ? 1 : 0);
    }, 0);
  }

  async function openVisitsForViewer() {
    if (!viewerDetail) return;
    // Visits are deep-tier only (the endpoint answers 402 on Free); never request them there.
    if (!deepAnalytics) {
      openUpgrade("analytics_history");
      return;
    }
    setVisitsModalOpen(true);
    setVisitsError(null);
    setVisits([]);
    setVisitDetail(null);
    setVisitDetailError(null);
    setVisitsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("kind", viewerDetail.kind);
      params.set("limit", "50");
      if (viewerDetail.kind === "authed") params.set("userId", viewerDetail.key);
      else params.set("botIdHash", viewerDetail.key);
      // Follow the page's link filter, like every other request here. Without it the modal listed
      // this viewer's sessions through every link while the tiles above showed one link's numbers.
      if (shareId) params.set("shareId", shareId);
      const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/shareviews/visits?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json().catch(() => null)) as any;
      if (!json || typeof json !== "object" || json.ok !== true || !Array.isArray(json.visits)) throw new Error("Invalid response");
      setVisits((json as ShareViewerVisitsResponse).visits);
    } catch (e) {
      setVisitsError(e instanceof Error ? e.message : "Failed to load visits");
    } finally {
      setVisitsLoading(false);
    }
  }

  async function openVisitDetail(visitId: string) {
    if (!deepAnalytics) {
      openUpgrade("analytics_history");
      return;
    }
    setVisitDetail(null);
    setVisitDetailError(null);
    setVisitDetailLoading(true);
    try {
      const res = await fetchWithTempUser(
        `/api/docs/${encodeURIComponent(docId)}/shareviews/visits/${encodeURIComponent(visitId)}${
          shareId ? `?shareId=${encodeURIComponent(shareId)}` : ""
        }`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json().catch(() => null)) as any;
      if (!json || typeof json !== "object" || json.ok !== true || !json.visit) throw new Error("Invalid response");
      setVisitDetail((json as ShareViewerVisitDetailResponse).visit);
    } catch (e) {
      setVisitDetailError(e instanceof Error ? e.message : "Failed to load visit details");
    } finally {
      setVisitDetailLoading(false);
    }
  }

  const dateRangeLabel = useMemo(() => {
    if (!series.length) return `Last ${days} days`;
    const first = series[0]?.date ?? "";
    const last = series[series.length - 1]?.date ?? "";
    return first && last ? `${first} → ${last}` : `Last ${days} days`;
  }, [series, days]);

  // Keep modal pagination in-bounds if the list size changes.
  useEffect(() => {
    if (authedViewersModalOpen && authedViewersModalPage !== authedModalPageSafe) setAuthedViewersModalPage(authedModalPageSafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedViewersModalOpen, authedModalPageSafe]);
  useEffect(() => {
    if (anonViewersModalOpen && anonViewersModalPage !== anonModalPageSafe) setAnonViewersModalPage(anonModalPageSafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anonViewersModalOpen, anonModalPageSafe]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <Link
          href={`/doc/${encodeURIComponent(docId)}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Back to document"
          title="Back to document"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{docTitle || "Document"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Link href={`/doc/${encodeURIComponent(docId)}`} className="hover:underline underline-offset-4">
              Document
            </Link>
            <span aria-hidden="true">›</span>
            <span className="font-medium text-[var(--fg)]">Metrics</span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="w-full px-6 py-6">
          <div className="mt-1 grid gap-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {/* The scope belongs in the heading, not only in a chip row that scrolls away:
                    a reader who lands further down the page was otherwise reading one link's
                    numbers under a heading that said "Metrics" and section titles that said
                    "this document". */}
                <div className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold text-[var(--fg)]">
                  <span>Metrics</span>
                  {selectedLinkLabel ? (
                    <>
                      <span className="text-[var(--muted-2)]" aria-hidden="true">
                        ·
                      </span>
                      <span className="max-w-[260px] truncate">{selectedLinkLabel}</span>
                      <button
                        type="button"
                        onClick={() => selectLink(null)}
                        className="text-[12px] font-medium text-[var(--muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                      >
                        Clear
                      </button>
                    </>
                  ) : links && links.length > 1 ? (
                    <span className="text-[13px] font-normal text-[var(--muted-2)]">· all {links.length} links</span>
                  ) : null}
                </div>
                <div className="mt-1 text-sm text-[var(--muted)]">{dateRangeLabel}</div>
                {analyticsDaysLimit !== null ? (
                  <div className="mt-1 text-xs text-[var(--muted-2)]">
                    Free shows the last {analyticsDaysLimit} days ·{" "}
                    <button
                      type="button"
                      className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                      onClick={() => openUpgrade("analytics_history")}
                    >
                      Upgrade for full history
                    </button>
                  </div>
                ) : null}
              </div>

              <div ref={rootRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setRangeOpen((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                  aria-label="Select date range"
                  title="Select date range"
                >
                  {rangeLabel}
                  <ChevronDown />
                </button>

                {rangeOpen ? (
                  <div className="absolute right-0 top-[calc(100%+8px)] z-10 w-56 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl ring-1 ring-black/5">
                    <div className="p-2">
                      {rangeOptions.map((opt) => {
                        const active = opt.value === days;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              setDays(opt.value);
                              setRangeOpen(false);
                            }}
                            className={[
                              "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm",
                              active ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
                            ].join(" ")}
                          >
                            <span>{opt.label}</span>
                            {active ? <Check /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {filterDroppedNotice ? (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5 text-[13px] text-[var(--fg)]">
                <span>That link was deleted — showing all links, so every number below is the whole document now.</span>
                <button
                  type="button"
                  onClick={() => setFilterDroppedNotice(false)}
                  className="shrink-0 font-medium text-[var(--muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}

            {/* The chip row that used to live here listed every link as a pill. It wrapped to two
                rows at twelve links and would have buried the page at a hundred — and it duplicated
                the Links table below, which lists the same links, scales, and carries the numbers
                that make the choice an informed one. One picker for "jump to a link", one table for
                "compare links". See `LinkPicker`. */}
            {links && links.length > 1 ? (
              <LinkPicker
                links={links}
                shareId={shareId}
                stats={linkStats}
                onSelect={selectLink}
                open={linkPickerOpen}
                setOpen={setLinkPickerOpen}
              />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
              {/* Views card */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">VIEWS</div>

                  {loading ? (
                    <div className="mt-1 h-9 w-16 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  ) : error ? (
                    <div className="mt-1 text-sm text-red-700">{error}</div>
                  ) : (
                    <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">{views}</div>
                  )}

                  <div className="mt-2 text-sm text-[var(--muted)]">
                    {loading ? (
                      <div className="h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                    ) : (
                      <>
                        {/* Opens first: it is the fact the big number above cannot carry. That
                            number counts recipients, so a reader who came back every morning for a
                            week is one view — the returns only show up here. */}
                        {opens !== null ? (
                          <>
                            <span className="tabular-nums">{opens}</span> open{opens === 1 ? "" : "s"}
                            {opens > views ? (
                              <span className="text-[var(--muted-2)]">
                                {" "}
                                ({(opens - views).toLocaleString()} return{opens - views === 1 ? "" : "s"})
                              </span>
                            ) : null}{" "}
                            ·{" "}
                          </>
                        ) : null}
                        <span className="tabular-nums">{pagesViewed}</span> pages viewed ·{" "}
                        {analyticsTier === null ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-3 w-12 rounded bg-[var(--panel-hover)] motion-safe:animate-pulse" aria-hidden="true" />
                            <span>viewers</span>
                          </span>
                        ) : !deepAnalytics ? (
                          <>
                            <span className="tabular-nums">{viewerCount}</span> {viewerCount === 1 ? "person" : "people"}
                          </>
                        ) : viewersLoading ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-3 w-12 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                            <span>authenticated viewers</span>
                          </span>
                        ) : viewersLoaded ? (
                          <>
                            <span className="tabular-nums">{authedViewers}</span> authenticated viewers
                            {typeof data?.totals?.anonymousViewers === "number" ? (
                              <>
                                {" "}
                                · <span className="tabular-nums">{anonViewers}</span> anonymous viewers
                              </>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <span className="tabular-nums">—</span> authenticated viewers
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Downloads card */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">DOWNLOADS</div>

                  {loading ? (
                    <div className="mt-1 h-9 w-20 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  ) : error ? (
                    <div className="mt-1 text-sm text-red-700">{error}</div>
                  ) : downloadsKnown ? (
                    // Real downloads stay visible after downloads are turned off: they happened.
                    <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">{downloads}</div>
                  ) : (
                    <div className="mt-1 h-9 w-20 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  )}

                  <div className="mt-2 text-sm text-[var(--muted)]">
                    {loading ? (
                      <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                    ) : downloadsEnabled ? (
                      <span className="text-[var(--muted)]">PDF downloads</span>
                    ) : downloadsKnown && downloads > 0 ? (
                      <span className="text-[var(--muted)]">
                        {selectedLinkLabel ? `Downloads are now off for ${selectedLinkLabel}.` : "Downloads are now off on every link."}
                      </span>
                    ) : (
                      // "this share link" named one link on a surface that aggregates all of them,
                      // so the reader could not tell what the sentence was about.
                      <span className="text-[var(--muted)]">
                        {selectedLinkLabel
                          ? `PDF download is off for ${selectedLinkLabel}.`
                          : "No link of this document allows PDF download."}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Two separate charts (Views + Downloads) */}
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="text-sm font-semibold text-[var(--fg)]">Views</div>
                <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
                  {loading ? (
                    <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  ) : (
                    <MiniLineChartSingle
                      series={chartSeries}
                      values={viewsSeries}
                      stroke="rgb(16 185 129)"
                      fillId="lnkdrpMetricsPageFillViews"
                      fillStops={{ topOpacity: 0.22, bottomOpacity: 0 }}
                    />
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--fg)]">Downloads</div>
                  {!loading && !downloadsEnabled ? <div className="text-xs font-medium text-[var(--muted)]">Downloads off</div> : null}
                </div>
                <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
                  {loading ? (
                    <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  ) : (
                    <MiniLineChartSingle
                      series={chartSeries}
                      values={downloadsSeries}
                      stroke="rgb(34 197 94)"
                      fillId="lnkdrpMetricsPageFillDownloads"
                      fillStops={{ topOpacity: 0.18, bottomOpacity: 0 }}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* One live link plus a deleted one that still contributes rows is still two links
                worth of traffic in the tiles above, and this table is the only thing that
                reconciles them — gating it on the live count alone hid the explanation exactly
                when it was needed. */}
            {links && links.length + (deletedLinkResidual ? 1 : 0) > 1 ? (
              <div className="mt-1">
                <div className="text-sm font-semibold text-[var(--fg)]">Which link is doing the work</div>
                <div className="mt-1 text-sm text-[var(--muted)]">
                  {/* One sentence, one job: say what the table answers. The previous copy tried to
                      explain the table, its relationship to the cards and the filter mechanics in
                      one breath, and the user asked what the section meant — the clearest possible
                      signal it explained nothing. It also claimed the rows "add up to the figures
                      above", which is false whenever a link is selected (cards show one link, rows
                      show all), so it told readers to check arithmetic that cannot reconcile. The
                      row has no click handler, only the link name does, hence "select a name". */}
                  Every link on this document, side by side, over the last {days} days.{" "}
                  {shareId ? (
                    <>
                      The highlighted row is the link the cards above are showing. Select another name to switch,
                      or{" "}
                      <button
                        type="button"
                        onClick={() => selectLink(null)}
                        className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                      >
                        show all links together
                      </button>
                      .
                    </>
                  ) : (
                    "Select a name to see that link alone in the cards above."
                  )}
                </div>

                <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--muted-2)]">
                          <th scope="col" className="px-4 py-2 font-semibold">Link</th>
                          {/* No "Views" column beside this one: a `ShareView` row is unique per
                              (link, viewer) for life, so the per-link view count and the per-link
                              viewer count are the same number by construction — two columns of
                              identical figures invited the reader to look for a difference that
                              cannot exist. See the header of the shareviews route. */}
                          <th scope="col" className="px-4 py-2 text-right font-semibold">Viewers</th>
                          {/* Opens earns a column where Views could not: Views and Viewers are the
                              same arithmetic on a `ShareView` row, but Opens counts sessions, so a
                              link read twice by one person reads 1 viewer, 2 opens. */}
                          <th scope="col" className="px-4 py-2 text-right font-semibold">Opens</th>
                          <th scope="col" className="px-4 py-2 text-right font-semibold">Downloads</th>
                          <th scope="col" className="px-4 py-2 text-right font-semibold">Last viewed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {links.map((l) => {
                          const s = linkStats[l.id];
                          const active = shareId === l.shareId;
                          return (
                            <tr
                              key={l.id}
                              className={[
                                "border-b border-[var(--border)] last:border-b-0",
                                active ? "bg-[var(--panel-hover)]" : "",
                              ].join(" ")}
                            >
                              <td className={["px-4 py-2", active ? "border-l-2 border-[var(--fg)]" : "border-l-2 border-transparent"].join(" ")}>
                                <button
                                  type="button"
                                  onClick={() => selectLink(active ? null : l.shareId)}
                                  className="max-w-[260px] truncate text-left font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                                  title={l.audience ?? l.label}
                                  aria-pressed={active}
                                >
                                  {l.label}
                                </button>
                                {/* A tinted row is not a state anyone reads; the user screenshotted
                                    the selected row and could not tell it was selected. */}
                                {active ? (
                                  <span className="ml-2 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                                    Selected
                                  </span>
                                ) : null}
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-2)]">
                                  {l.audience ? <span className="truncate">{l.audience}</span> : null}
                                  {l.status !== "active" ? <span className="capitalize">{l.status}</span> : null}
                                </div>
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-[var(--fg)]">{s ? s.viewers : "—"}</td>
                              <td className="px-4 py-2 text-right tabular-nums text-[var(--fg)]">{s ? s.opens : "—"}</td>
                              <td className="px-4 py-2 text-right tabular-nums text-[var(--fg)]">{s ? s.downloads : "—"}</td>
                              {/* The analytics timestamp first: the link row's own `lastViewedAt`
                                  only started moving when links shipped, so a link that adopted a
                                  document's older traffic printed "—" beside a non-zero Views cell. */}
                              <td className="px-4 py-2 text-right text-[var(--muted)]">
                                {s?.lastViewedAt
                                  ? formatDateTime(s.lastViewedAt)
                                  : l.lastViewedAt
                                    ? formatDateTime(l.lastViewedAt)
                                    : "—"}
                              </td>
                            </tr>
                          );
                        })}
                        {/* Deleted links keep their analytics (that is the promise the links page
                            makes) and their rows are still in the document total, but the links
                            endpoint does not return them — so without this row the column silently
                            fails to add up to the card above it. */}
                        {deletedLinkResidual ? (
                          <tr className="border-b border-[var(--border)] text-[var(--muted)] last:border-b-0">
                            <td className="px-4 py-2">
                              <span className="font-medium">
                                {deletedLinkResidual.count === 1 ? "Deleted link" : `${deletedLinkResidual.count} deleted links`}
                              </span>
                              <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">Still counted in the totals above</div>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{deletedLinkResidual.viewers}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{deletedLinkResidual.opens}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{deletedLinkResidual.downloads}</td>
                            <td className="px-4 py-2 text-right">—</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}

            {!deepAnalytics ? (
              <LockedViewersBlock
                pending={analyticsTier === null}
                loading={loading || !hasData}
                count={viewerCount}
                days={days}
                linkLabel={selectedLinkLabel}
                onUpgrade={() => openUpgrade("analytics_history")}
              />
            ) : (
              <>
                <div className="mt-1">
                  <div className="text-sm font-semibold text-[var(--fg)]">Authenticated viewers</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">Only signed-in viewers are listed here.</div>

                  <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                    <div>
                      {loading ? (
                        <div className="p-4">
                          <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                          <div className="mt-3 h-4 w-72 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                          <div className="mt-3 h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                        </div>
                      ) : error ? (
                        <div className="p-4 text-sm text-red-700">{error}</div>
                      ) : !hasData ? (
                        <div className="p-4 text-sm text-[var(--muted)]">No data yet.</div>
                      ) : viewersLoading ? (
                        <div className="p-4 text-sm text-[var(--muted)]">Loading authenticated viewers…</div>
                      ) : !data?.viewers?.length ? (
                        <div className="p-4 text-sm text-[var(--muted)]">No authenticated viewers yet.</div>
                      ) : (
                        <ul className="divide-y divide-[var(--border)]">
                          {authedViewersTop.map((v) => (
                            <li key={v.userId} className="hover:bg-[var(--panel-hover)]">
                              <button
                                type="button"
                                onClick={() => openAuthedViewerDetail(v)}
                                className="grid w-full gap-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
                                title="View details"
                              >
                                <div className="min-w-0">
                                  {(() => {
                                    const name = typeof v.name === "string" ? v.name.trim() : "";
                                    const email = typeof v.email === "string" ? v.email.trim() : "";
                                    const title = name || email || "Signed-in user";
                                    const showEmailLine = Boolean(name && email);
                                    const shortId = formatShortId(v.userId);
                                    const showIdLine = !showEmailLine && !email && shortId;
                                    return (
                                      <>
                                        <div className="truncate text-sm font-semibold text-[var(--fg)]">{title}</div>
                                        {showEmailLine ? (
                                          <div className="truncate text-xs text-[var(--muted-2)]">{email}</div>
                                        ) : showIdLine ? (
                                          <div className="truncate text-xs text-[var(--muted-2)]">User ID {shortId}</div>
                                        ) : null}
                                      </>
                                    );
                                  })()}
                                </div>
                                <div className="shrink-0 sm:text-right">
                                  <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">
                                    {v.views} views
                                    {typeof v.pagesViewed === "number" ? <> · {v.pagesViewed} pages</> : null}
                                  </div>
                                  <div className="mt-0.5 text-xs text-[var(--muted)]">Last seen {formatDateTime(v.lastSeen)}</div>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {authedViewersList.length > 5 ? (
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAuthedViewersModalPage(0);
                          setAuthedViewersModalOpen(true);
                        }}
                      >
                        See more
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="mt-6">
                  <div className="text-sm font-semibold text-[var(--fg)]">Anonymous viewers</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    Anonymous viewers are tracked per browser/device (best-effort).
                  </div>

                  <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                    <div>
                      {loading ? (
                        <div className="p-4">
                          <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                          <div className="mt-3 h-4 w-72 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                          <div className="mt-3 h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                        </div>
                      ) : error ? (
                        <div className="p-4 text-sm text-red-700">{error}</div>
                      ) : !hasData ? (
                        <div className="p-4 text-sm text-[var(--muted)]">No data yet.</div>
                      ) : viewersLoading ? (
                        <div className="p-4 text-sm text-[var(--muted)]">Loading anonymous viewers…</div>
                      ) : !anonymousViewersList.length ? (
                        <div className="p-4 text-sm text-[var(--muted)]">No anonymous viewers yet.</div>
                      ) : (
                        <ul className="divide-y divide-[var(--border)]">
                          {anonViewersTop.map((v) => (
                            <li
                              key={typeof v.botIdHash === "string" ? v.botIdHash : "anon"}
                              className="hover:bg-[var(--panel-hover)]"
                            >
                              <button
                                type="button"
                                onClick={() => openAnonViewerDetail(v)}
                                className="grid w-full gap-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
                                title="View details"
                              >
                                <div className="min-w-0">
                                  {(() => {
                                    const name = typeof (v as any).name === "string" ? String((v as any).name).trim() : "";
                                    const email = typeof (v as any).email === "string" ? String((v as any).email).trim() : "";
                                    const title = name || email || "Anonymous viewer";
                                    const showEmailLine = Boolean(name && email);
                                    return (
                                      <>
                                        <div className="flex items-center gap-2 truncate text-sm font-semibold text-[var(--fg)]">
                                          <UserIcon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                                          <span className="truncate">{title}</span>
                                        </div>
                                        {showEmailLine ? (
                                          <div className="mt-0.5 truncate text-xs text-[var(--muted-2)]">{email}</div>
                                        ) : (
                                          <div className="mt-0.5 text-xs text-[var(--muted-2)]">First seen {formatDateTime(v.firstSeen)}</div>
                                        )}
                                      </>
                                    );
                                  })()}
                                </div>
                                <div className="shrink-0 sm:text-right">
                                  <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">
                                    {v.views} views
                                    {typeof v.pagesViewed === "number" ? <> · {v.pagesViewed} pages</> : null}
                                  </div>
                                  <div className="mt-0.5 text-xs text-[var(--muted)]">Last seen {formatDateTime(v.lastSeen)}</div>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {anonymousViewersList.length > 5 ? (
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAnonViewersModalPage(0);
                          setAnonViewersModalOpen(true);
                        }}
                      >
                        See more
                      </Button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Modal open={authedViewersModalOpen} onClose={() => setAuthedViewersModalOpen(false)} ariaLabel="Authenticated viewers">
        <div className="text-base font-semibold text-[var(--fg)]">Authenticated viewers</div>
        <div className="mt-1 text-sm text-[var(--muted)]">Only signed-in viewers are listed here.</div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
          {!authedViewersList.length ? (
            <div className="p-4 text-sm text-[var(--muted)]">No authenticated viewers yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {authedModalItems.map((v) => (
                <li key={v.userId} className="hover:bg-[var(--panel-hover)]">
                  <button
                    type="button"
                    onClick={() => openAuthedViewerDetail(v)}
                    className="grid w-full gap-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
                    title="View details"
                  >
                    <div className="min-w-0">
                      {(() => {
                        const name = typeof v.name === "string" ? v.name.trim() : "";
                        const email = typeof v.email === "string" ? v.email.trim() : "";
                        const title = name || email || "Signed-in user";
                        const showEmailLine = Boolean(name && email);
                        const shortId = formatShortId(v.userId);
                        const showIdLine = !showEmailLine && !email && shortId;
                        return (
                          <>
                            <div className="truncate text-sm font-semibold text-[var(--fg)]">{title}</div>
                            {showEmailLine ? (
                              <div className="truncate text-xs text-[var(--muted-2)]">{email}</div>
                            ) : showIdLine ? (
                              <div className="truncate text-xs text-[var(--muted-2)]">User ID {shortId}</div>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                    <div className="shrink-0 sm:text-right">
                      <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">
                        {v.views} views
                        {typeof v.pagesViewed === "number" ? <> · {v.pagesViewed} pages</> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--muted)]">Last seen {formatDateTime(v.lastSeen)}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {authedModalTotal > VIEWERS_PAGE_SIZE ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[var(--muted)] tabular-nums">
              Showing {authedModalTotal ? authedModalStart + 1 : 0}–{authedModalEnd} of {authedModalTotal}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAuthedViewersModalPage((p) => Math.max(0, p - 1))}
                disabled={authedModalPageSafe <= 0}
              >
                Prev
              </Button>
              <div className="text-xs text-[var(--muted)] tabular-nums">
                Page {authedModalPageSafe + 1} / {authedModalPages}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAuthedViewersModalPage((p) => Math.min(authedModalPages - 1, p + 1))}
                disabled={authedModalPageSafe >= authedModalPages - 1}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={anonViewersModalOpen} onClose={() => setAnonViewersModalOpen(false)} ariaLabel="Anonymous viewers">
        <div className="text-base font-semibold text-[var(--fg)]">Anonymous viewers</div>
        <div className="mt-1 text-sm text-[var(--muted)]">Tracked per browser/device (best-effort).</div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
          {!anonymousViewersList.length ? (
            <div className="p-4 text-sm text-[var(--muted)]">No anonymous viewers yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {anonModalItems.map((v) => (
                <li key={typeof v.botIdHash === "string" ? v.botIdHash : "anon"} className="hover:bg-[var(--panel-hover)]">
                  <button
                    type="button"
                    onClick={() => openAnonViewerDetail(v)}
                    className="grid w-full gap-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
                    title="View details"
                  >
                    <div className="min-w-0">
                      {(() => {
                        const name = typeof (v as any).name === "string" ? String((v as any).name).trim() : "";
                        const email = typeof (v as any).email === "string" ? String((v as any).email).trim() : "";
                        const title = name || email || "Anonymous viewer";
                        const showEmailLine = Boolean(name && email);
                        return (
                          <>
                            <div className="flex items-center gap-2 truncate text-sm font-semibold text-[var(--fg)]">
                              <UserIcon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                              <span className="truncate">{title}</span>
                            </div>
                            {showEmailLine ? (
                              <div className="mt-0.5 truncate text-xs text-[var(--muted-2)]">{email}</div>
                            ) : (
                              <div className="mt-0.5 text-xs text-[var(--muted-2)]">First seen {formatDateTime(v.firstSeen)}</div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <div className="shrink-0 sm:text-right">
                      <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">
                        {v.views} views
                        {typeof v.pagesViewed === "number" ? <> · {v.pagesViewed} pages</> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--muted)]">Last seen {formatDateTime(v.lastSeen)}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {anonModalTotal > VIEWERS_PAGE_SIZE ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[var(--muted)] tabular-nums">
              Showing {anonModalTotal ? anonModalStart + 1 : 0}–{anonModalEnd} of {anonModalTotal}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAnonViewersModalPage((p) => Math.max(0, p - 1))}
                disabled={anonModalPageSafe <= 0}
              >
                Prev
              </Button>
              <div className="text-xs text-[var(--muted)] tabular-nums">
                Page {anonModalPageSafe + 1} / {anonModalPages}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAnonViewersModalPage((p) => Math.min(anonModalPages - 1, p + 1))}
                disabled={anonModalPageSafe >= anonModalPages - 1}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(viewerDetail)} onClose={() => setViewerDetail(null)} ariaLabel="Viewer details">
        {!viewerDetail ? null : (
          <>
            <div className="text-base font-semibold text-[var(--fg)]">{viewerDetail.title}</div>
            {viewerDetail.subtitle ? <div className="mt-1 text-sm text-[var(--muted)]">{viewerDetail.subtitle}</div> : null}

            <div className="mt-4 grid gap-4">
              <div className="grid gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">ACTIVITY</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-[var(--muted)]">
                      {viewerDetail.kind === "authed" ? "Authenticated viewer" : "Anonymous viewer"}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => void openVisitsForViewer()}>
                      Visits
                    </Button>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span className="tabular-nums text-[var(--fg)]">
                    {viewerDetail.views} {viewerDetail.views === 1 ? "view" : "views"}
                  </span>
                  <span className="tabular-nums text-[var(--fg)]">
                    {viewerDetail.pagesViewed} {viewerDetail.pagesViewed === 1 ? "page" : "pages"}
                  </span>
                  {viewerTimeTotalMs > 0 ? (
                    <span className="tabular-nums text-[var(--fg)]">
                      {viewerDetail.timeSpentMs > 0 ? (
                        <>Time spent {formatDurationShort(viewerDetail.timeSpentMs)}</>
                      ) : (
                        <>Activity span ~{formatDurationShort(viewerDetail.timeOpenMs)}</>
                      )}
                    </span>
                  ) : null}
                  {viewerTrackedAvgPerViewMs > 0 ? (
                    <span className="tabular-nums text-[var(--fg)]">
                      Avg / view {formatDurationShort(viewerTrackedAvgPerViewMs)}
                    </span>
                  ) : null}
                  {viewerTrackedAvgPerPageMs > 0 ? (
                    <span className="tabular-nums text-[var(--fg)]">
                      Avg / page {formatDurationShort(viewerTrackedAvgPerPageMs)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 text-xs text-[var(--muted)]">
                  First seen {formatDateTime(viewerDetail.firstSeen)} · Last seen {formatDateTime(viewerDetail.lastSeen)}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">PAGES SEEN</div>
                {!viewerDetail.pagesSeen.length ? (
                  <div className="mt-2 text-sm text-[var(--muted)]">No page-level data yet.</div>
                ) : (
                  <>
                    <div className="mt-2 text-sm text-[var(--muted)]">{formatPageRanges(viewerDetail.pagesSeen)}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {viewerDetail.pagesSeen.slice(0, 60).map((p) => (
                        (() => {
                          const raw = viewerDetail.pageTimeMsByPage?.[String(p)];
                          const actualMs = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
                          const ms = actualMs;
                          const tiny = ms > 0 ? formatDurationTiny(ms) : "";
                          return (
                        <span
                          key={`page:${viewerDetail.key}:${p}`}
                            tabIndex={ms > 0 ? 0 : -1}
                            className="group relative inline-flex flex-col items-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--fg)] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                        >
                            <span className="leading-4">{p}</span>
                            {tiny ? <span className="mt-0.5 text-[10px] font-medium text-[var(--muted-2)]">{tiny}</span> : null}
                            {ms > 0 ? (
                              <span className="pointer-events-none absolute -top-2 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-medium text-[var(--fg)] shadow-xl group-hover:block group-focus-visible:block">
                                Time on page: {formatDurationShort(ms)}
                              </span>
                            ) : null}
                        </span>
                          );
                        })()
                      ))}
                      {viewerDetail.pagesSeen.length > 60 ? (
                        <span className="text-xs text-[var(--muted)]">+{viewerDetail.pagesSeen.length - 60} more</span>
                      ) : null}
                    </div>
                    {!viewerHasRealPerPageTime ? (
                      <div className="mt-2 text-xs text-[var(--muted)]">
                        Per-page time is best-effort and only appears after a viewer navigates with the updated share viewer.
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </Modal>

      <Modal open={visitsModalOpen} onClose={() => setVisitsModalOpen(false)} ariaLabel="Viewer visits">
        <div className="text-base font-semibold text-[var(--fg)]">Visits</div>
        <div className="mt-1 text-sm text-[var(--muted)]">
          Per-tab visits (best-effort). A “visit” is scoped to a single browser tab session.
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
          {visitsLoading ? (
            <div className="p-4 text-sm text-[var(--muted)]">Loading visits…</div>
          ) : visitsError ? (
            <div className="p-4 text-sm text-red-700">{visitsError}</div>
          ) : !visits.length ? (
            <div className="p-4 text-sm text-[var(--muted)]">No visit data yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {visits.map((v) => {
                const startedAt = v.startedAt;
                const lastEventAt = v.lastEventAt;
                const revisited = countRevisitedPages(v);
                return (
                  <li key={v.visitId} className="hover:bg-[var(--panel-hover)]">
                    <button
                      type="button"
                      onClick={() => void openVisitDetail(v.visitId)}
                      className="grid w-full gap-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
                      title="View visit details"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[var(--fg)]">
                          {formatDateTime(startedAt)} → {formatDateTime(lastEventAt)}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[var(--muted-2)]">
                          {v.pagesSeen?.length ?? 0} pages · {revisited} revisited
                        </div>
                      </div>
                      <div className="shrink-0 sm:text-right">
                        <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">
                          {formatDurationShort(v.timeSpentMs)}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => void openVisitsForViewer()} disabled={visitsLoading}>
            Refresh
          </Button>
        </div>
      </Modal>

      <Modal
        open={Boolean(visitDetail) || visitDetailLoading || Boolean(visitDetailError)}
        onClose={() => {
          setVisitDetail(null);
          setVisitDetailError(null);
          setVisitDetailLoading(false);
        }}
        ariaLabel="Visit details"
      >
        <div className="text-base font-semibold text-[var(--fg)]">Visit details</div>
        {visitDetailLoading ? (
          <div className="mt-2 text-sm text-[var(--muted)]">Loading…</div>
        ) : visitDetailError ? (
          <div className="mt-2 text-sm text-red-700">{visitDetailError}</div>
        ) : !visitDetail ? (
          <div className="mt-2 text-sm text-[var(--muted)]">No details.</div>
        ) : (
          <div className="mt-4 grid gap-4">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
              <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">SUMMARY</div>
              <div className="mt-2 text-sm text-[var(--muted)]">
                {formatDateTime(visitDetail.startedAt)} → {formatDateTime(visitDetail.lastEventAt)}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="tabular-nums text-[var(--fg)]">Time spent {formatDurationShort(visitDetail.timeSpentMs)}</span>
                <span className="tabular-nums text-[var(--fg)]">{visitDetail.pagesSeen.length} pages</span>
                <span className="tabular-nums text-[var(--fg)]">{visitDetail.revisitedPages.length} revisited</span>
              </div>
              {visitDetail.pagesSeen.length ? (
                <div className="mt-2 text-xs text-[var(--muted)]">Pages: {formatPageRanges(visitDetail.pagesSeen)}</div>
              ) : null}
              {visitDetail.revisitedPages.length ? (
                <div className="mt-1 text-xs text-[var(--muted)]">Revisited: {formatPageRanges(visitDetail.revisitedPages)}</div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
              <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">PAGE SEQUENCE</div>
              {!visitDetail.events.length ? (
                <div className="mt-2 text-sm text-[var(--muted)]">No sequence data yet.</div>
              ) : (
                <div className="mt-3 max-h-[340px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
                  <ul className="divide-y divide-[var(--border)]">
                    {visitDetail.events.slice(0, 250).map((e, idx) => (
                      <li key={`${visitDetail.visitId}:ev:${idx}`} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-[var(--fg)] tabular-nums">Page {e.pageNumber}</div>
                          <div className="text-xs text-[var(--muted-2)] tabular-nums">{formatDurationTiny(e.durationMs)}</div>
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--muted)]">
                          {formatDateTime(e.enteredAt)} → {formatDateTime(e.leftAt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}


