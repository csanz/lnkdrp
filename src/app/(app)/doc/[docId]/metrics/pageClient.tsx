/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, UserIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import Button from "@/components/ui/Button";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { Area, AreaChart, CartesianGrid, Tooltip, YAxis } from "recharts";

type MetricsResponse = {
  ok: true;
  docTitle?: string;
  days: number;
  totals: {
    views: number;
    downloads: number;
    pagesViewed: number;
    authenticatedViewers: number;
    anonymousViewers?: number;
  };
  downloadsEnabled?: boolean;
  series: Array<{ date: string; views: number; downloads: number }>;
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
/**
 * Render the MetricsPageClient UI (uses effects, local state).
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
  const rangeLabel = useMemo(() => `Last ${days} days`, [days]);
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
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&lite=1`,
          { cache: "no-store" },
        );
        if (res.status === 404) {
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
  }, [docId, days]);

  // Auto-load the viewers list after the lightweight payload returns (no button).
  useEffect(() => {
    if (!data?.ok) return;
    if (viewersLoading || viewersLoaded) return;
    let cancelled = false;
    setViewersLoading(true);
    void (async () => {
      try {
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&viewers=1&viewersOnly=1`,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, days, data?.ok]);

  const views = data?.totals?.views ?? 0;
  const downloads = data?.totals?.downloads ?? 0;
  const pagesViewed = data?.totals?.pagesViewed ?? 0;
  const authedViewers = data?.totals?.authenticatedViewers ?? 0;
  const anonViewers = data?.totals?.anonymousViewers ?? 0;
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
    setVisitDetail(null);
    setVisitDetailError(null);
    setVisitDetailLoading(true);
    try {
      const res = await fetchWithTempUser(
        `/api/docs/${encodeURIComponent(docId)}/shareviews/visits/${encodeURIComponent(visitId)}`,
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
        <div className="mx-auto w-full max-w-[1400px] px-6 py-6">
          <div className="mt-1 grid gap-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-base font-semibold text-[var(--fg)]">Metrics</div>
                <div className="mt-1 text-sm text-[var(--muted)]">{dateRangeLabel}</div>
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
                      {[
                        { label: "Last 3 days", value: 3 },
                        { label: "Last 7 days", value: 7 },
                        { label: "Last 15 days", value: 15 },
                        { label: "Last 30 days", value: 30 },
                      ].map((opt) => {
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
                        <span className="tabular-nums">{pagesViewed}</span> pages viewed ·{" "}
                        {viewersLoading ? (
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
                  ) : downloadsEnabled ? (
                    <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">{downloads}</div>
                  ) : (
                    <div className="mt-2 text-sm font-semibold text-[var(--muted)]">Not enabled</div>
                  )}

                  <div className="mt-2 text-sm text-[var(--muted)]">
                    {loading ? (
                      <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                    ) : downloadsEnabled ? (
                      <span className="text-[var(--muted)]">PDF downloads</span>
                    ) : (
                      <span className="text-[var(--muted)]">PDF download is disabled for this share link.</span>
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
                  {!loading && !downloadsEnabled ? <div className="text-xs font-medium text-[var(--muted)]">Not enabled</div> : null}
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


