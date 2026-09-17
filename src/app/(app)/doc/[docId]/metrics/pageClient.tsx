/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 */
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, LockClosedIcon, UserIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import Button from "@/components/ui/Button";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { usePlan } from "@/lib/client/usePlan";
import { Area, AreaChart, CartesianGrid, LabelList, Tooltip, YAxis } from "recharts";
import { formatDayKey } from "@/lib/format/date";
import { valueLabels } from "@/components/charts/ChartValueLabel";

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
  /** Absent on a `?viewersOnly=1` response. */
  series?: Array<{ date: string; views: number; downloads: number }>;
  /** Count of live links on the document — always present, regardless of `?shareId=` scope. */
  linksTotal?: number;
  /**
   * Bounded ranking (top by views + top by recency, deduped, `topLinks=5` on the request) — never
   * "every link". Always the whole document's ranking, whatever `?shareId=` says, same as `linksTotal`.
   */
  byLink?: Array<{
    shareId: string;
    views: number;
    viewers: number;
    opens?: number;
    downloads: number;
    lastViewedAt: string | null;
    label?: string | null;
    isDefault?: boolean;
  }>;
  /** Traffic on links no live row owns (one summary, never a list) — see `deletedLinkResidual` on the route. */
  deletedLinkResidual?: { count: number; viewers: number; downloads: number } | null;
  /** The resolved link, only when `?shareId=` named one. */
  link?: {
    shareId: string;
    label: string;
    audience: string | null;
    isDefault: boolean;
    enabled: boolean;
    allowDownload: boolean;
    allowRevisionHistory: boolean;
    passwordEnabled: boolean;
    expiresAt: string | null;
    status: "active" | "disabled" | "expired" | "archived";
  } | null;
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

/** "12 Sep 2026" for the scoped link's expiry — `formatDateTime` above is for viewer timestamps. */
function formatDateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** "3h ago" / "12 Sep" for the LINKS card's mini lists, matching `DocQuickStats`. */
function relativeAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One "Label value" pair in the scoped link's settings row. */
function SettingItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[var(--muted-2)]">{label}</span>
      <span className="font-medium text-[var(--fg)]">{value}</span>
    </span>
  );
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
          <AreaChart width={size.w} height={size.h} data={data} margin={{ top: 18, right: 8, bottom: 4, left: 8 }}>
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
            >
              <LabelList dataKey="value" content={valueLabels({ values: safeValues })} />
            </Area>
          </AreaChart>
        )}
      </div>

      <div
        // Under the chart's own points (the plot is inset 8px each side, like `mx-2`), not in equal
        // grid cells: cell centres drifted off the points toward the edges, which the value labels
        // made plain. At most seven dates, evenly picked, so a 30- or 90-day range stays readable.
        className="relative mx-2 mt-3 h-4 text-[10px] tabular-nums text-[var(--muted)]"
      >
        {(() => {
          const n = series.length;
          const step = Math.max(1, Math.ceil((n - 1) / 6));
          return series.map((s, i) => {
            if (n > 1 && i % step !== 0 && i !== n - 1) return null;
            if (n > 1 && i !== n - 1 && n - 1 - i < step / 2) return null;
            const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
            const shift = n > 1 && i === 0 ? "0%" : n > 1 && i === n - 1 ? "-100%" : "-50%";
            return (
              <span key={`tick:${s.date}`} className="absolute top-0 whitespace-nowrap" style={{ left: `${pct}%`, transform: `translateX(${shift})` }}>
                {formatDayKey(s.date)}
              </span>
            );
          });
        })()}
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
  // Choosing a link happens on the Links page, which is the full per-link table; this page shows
  // one link (`?shareId=`) or the document. A picker and a comparison table lived here once and
  // were removed at the user's request: a reader who chose a link on the Links page had already
  // decided, and both controls stopped scaling long before the hundred links a document is
  // allowed. What replaced them is bounded on purpose: `data.link` (the one link this page is
  // scoped to, resolved server-side) and `data.byLink` (a top-N ranking, never every link) — see
  // the "LINKS" card and the per-link settings row below.
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
          // `byLink=1&topLinks=5`, unconditionally: the ranking and `linksTotal` are document-wide
          // regardless of `?shareId=` (the route computes them from `docScopeMatch`, not `scopeMatch`),
          // and bounded, so asking for them even on a single-link view costs nothing worth skipping.
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&lite=1&byLink=1&topLinks=5${linkFilterParam}`,
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

  /** The label of the selected link, for copy that must not say "this document" under a filter. */
  const selectedLinkLabel = useMemo(() => (shareId ? (data?.link?.label ?? "this link") : null), [shareId, data]);

  /**
   * The "LINKS" card's two lists: which links are pulling the traffic, and which are live right
   * now — ranked over `data.byLink`, the bounded top-5-by-views ∪ top-5-by-recency the server
   * already sent, never a fetch of every link. Only rendered in master mode (`!shareId`): under a
   * single-link filter this ranking would be comparing the very link the page is already about
   * against the others, which is a different question than the one this card answers.
   */
  const topLinksByViewers = useMemo(
    () => [...(data?.byLink ?? [])].sort((a, b) => b.viewers - a.viewers || b.views - a.views).slice(0, 3),
    [data],
  );
  /** Longest bar = 100%, so the bars read relative to each other, not to some absolute scale. */
  const maxTopLinkViewers = useMemo(() => Math.max(1, ...topLinksByViewers.map((r) => r.viewers)), [topLinksByViewers]);
  const recentlyOpenedLinks = useMemo(
    () =>
      [...(data?.byLink ?? [])]
        .filter((r) => Boolean(r.lastViewedAt))
        .sort((a, b) => Date.parse(b.lastViewedAt!) - Date.parse(a.lastViewedAt!))
        .slice(0, 3),
    [data],
  );

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
      {/* One link's metrics sit under the links list, not under the document: the back arrow and
          the breadcrumb both say so when `?shareId=` is set. Before this, a reader who came from
          /doc/:id/links and pressed back landed on the document page and had to find the list
          again — the one place the link they were just reading about actually lives. Hierarchical
          rather than referrer-based on purpose: the same URL is reached from the activity feed and
          the side panel, and the parent of a link is the list either way. */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <Link
          href={shareId ? `/doc/${encodeURIComponent(docId)}/links` : `/doc/${encodeURIComponent(docId)}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label={shareId ? "Back to links" : "Back to document"}
          title={shareId ? "Back to links" : "Back to document"}
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
            {shareId ? (
              <>
                <Link href={`/doc/${encodeURIComponent(docId)}/links`} className="hover:underline underline-offset-4">
                  Links
                </Link>
                <span aria-hidden="true">›</span>
                <span className="max-w-[240px] truncate font-medium text-[var(--fg)]">{selectedLinkLabel ?? "Link"}</span>
              </>
            ) : (
              <span className="font-medium text-[var(--fg)]">Metrics</span>
            )}
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
                  ) : typeof data?.linksTotal === "number" && data.linksTotal > 1 ? (
                    // A pill, not a trailing clause: this is the top-level, every-link view, and
                    // the count is the one fact that says so at a glance — the way a single-link
                    // view is unmistakable the moment it names the link. Before this it was small
                    // grey text that read as a footnote on "Metrics", so a reader had no way to
                    // tell "the whole document" apart from "the one link I'm looking at" without
                    // reading the number and doing the comparison themselves.
                    <span className="inline-flex items-center rounded-full bg-[var(--panel-hover)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--fg)] ring-1 ring-inset ring-[var(--border)]">
                      All {data.linksTotal} links
                    </span>
                  ) : null}
                </div>
                {/* The scoped link's own settings — the one thing a single-link view has that the
                    master view cannot (a document has no single "download" or "expiry" setting
                    once it owns more than one link). Without this, a link's metrics page was
                    indistinguishable from the document's except for a name in the breadcrumb: the
                    same four tiles, the same chart, just narrower numbers. */}
                {selectedLinkLabel && data?.link ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--muted)]">
                    {data.link.audience ? <SettingItem label="Audience" value={data.link.audience} /> : null}
                    <SettingItem label="Download" value={data.link.allowDownload ? "on" : "off"} />
                    <SettingItem label="Password" value={data.link.passwordEnabled ? "set" : "none"} />
                    <SettingItem label="Version history" value={data.link.allowRevisionHistory ? "on" : "off"} />
                    <SettingItem label="Expires" value={data.link.expiresAt ? formatDateShort(data.link.expiresAt) : "Never"} />
                    {typeof data.linksTotal === "number" && data.linksTotal > 1 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link
                          href={`/doc/${encodeURIComponent(docId)}/links`}
                          className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                        >
                          Part of {data.linksTotal} links
                        </Link>
                      </>
                    ) : null}
                  </div>
                ) : null}
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

            {/* The card that makes this the *master* metrics page rather than a wider version of
                a single link's: how many links this document has, which ones are pulling the
                traffic, and which are live right now. Master mode only — under a single-link
                filter this would be ranking the very link the page is about against the others,
                a different question than the one the reader is asking. Ranked and bounded to a
                handful of rows (`topLinksByViewers`/`recentlyOpenedLinks`, from the server's
                already-bounded `byLink`), never every link — see `DocLinksManager` for that. */}
            {!selectedLinkLabel && data && typeof data.linksTotal === "number" && data.linksTotal > 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">LINKS</div>
                    <div className="mt-1 text-3xl font-semibold tabular-nums text-[var(--fg)]">{data.linksTotal}</div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {data.linksTotal === 1
                        ? "One link, shown above"
                        : "Every number above is the sum across all of them"}
                    </div>
                  </div>
                  <Link
                    href={`/doc/${encodeURIComponent(docId)}/links`}
                    className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                  >
                    Manage links
                  </Link>
                </div>

                {topLinksByViewers.length || recentlyOpenedLinks.length ? (
                  <div className="mt-4 grid gap-x-6 gap-y-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Top links · by viewers
                      </div>
                      {/* Bars, not just a number column: length is the one thing that says "5 is a
                          lot more than 2" at a glance, which a right-aligned digit does not. Scaled
                          to the longest bar in this list, not to the document's own total — the
                          question these three rows answer is how the links compare to each other. */}
                      <ul className="mt-2 space-y-2">
                        {topLinksByViewers.map((r) => (
                          <li key={r.shareId} className="text-[13px]">
                            <div className="flex items-baseline justify-between gap-3">
                              {r.label ? (
                                <Link
                                  href={`/doc/${encodeURIComponent(docId)}/metrics?shareId=${encodeURIComponent(r.shareId)}`}
                                  className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                                >
                                  {r.label}
                                </Link>
                              ) : (
                                <span className="min-w-0 truncate text-[var(--muted)]" title="This link was deleted; its traffic is still counted above">
                                  Deleted link
                                </span>
                              )}
                              <span className="shrink-0 tabular-nums text-[var(--muted)]">
                                {r.viewers.toLocaleString()} viewer{r.viewers === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]">
                              <div
                                className="h-full rounded-full bg-[rgb(16_185_129)]"
                                style={{ width: `${Math.max(4, (r.viewers / maxTopLinkViewers) * 100)}%` }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">Recently opened</div>
                      <ul className="mt-1.5 space-y-1.5">
                        {recentlyOpenedLinks.map((r) => (
                          <li key={r.shareId} className="flex items-baseline justify-between gap-3 text-[13px]">
                            {r.label ? (
                              <Link
                                href={`/doc/${encodeURIComponent(docId)}/metrics?shareId=${encodeURIComponent(r.shareId)}`}
                                className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                              >
                                {r.label}
                              </Link>
                            ) : (
                              <span className="min-w-0 truncate text-[var(--muted)]" title="This link was deleted; its traffic is still counted above">
                                Deleted link
                              </span>
                            )}
                            <span className="shrink-0 whitespace-nowrap text-[var(--muted)]">{relativeAge(r.lastViewedAt)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}

                {/* Traffic the two lists above cannot show: a link that was deleted still keeps
                    its numbers in every total, and this is the one place that says why the rows
                    above do not, between them, add up to the document's own figures. */}
                {data.deletedLinkResidual ? (
                  <div className="mt-3 border-t border-[var(--border)] pt-3 text-[12px] text-[var(--muted)]">
                    <span className="font-medium text-[var(--fg)]">
                      {data.deletedLinkResidual.count === 1 ? "1 deleted link" : `${data.deletedLinkResidual.count} deleted links`}
                    </span>{" "}
                    still carr{data.deletedLinkResidual.count === 1 ? "ies" : "y"} {data.deletedLinkResidual.viewers.toLocaleString()}{" "}
                    viewer{data.deletedLinkResidual.viewers === 1 ? "" : "s"} in the totals above.
                  </div>
                ) : null}
              </div>
            ) : null}

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


