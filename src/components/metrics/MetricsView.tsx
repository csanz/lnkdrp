/**
 * MetricsView — the owner metrics page, for a document or for a project.
 *
 * Mounted by `/doc/:docId/metrics` and by `/project/:projectId/metrics`, which are thin shells
 * around it. It began as the document page's client; a project's metrics page has to answer the
 * same questions in the same shapes — the same header band, the same range picker, the same two
 * tiles, the same smooth area charts with count labels, the same per-link ranking, the same viewer
 * lists and the same Free clamp — and the alternative was a second two-thousand-line client that
 * would have drifted from this one on the first change to either.
 *
 * What the `scope` decides: the two URL families (the API base and the page base), the breadcrumb
 * noun, and two capabilities a project does not have —
 * - `supportsPageDetail`: per-page time and per-visit timelines are document facts. A project link
 *   spans many documents, so a viewer's "pages" is not a number about the project; the project
 *   reports **documents opened** in that column and its viewer rows are not clickable, because
 *   there is no per-page story behind them.
 * - `showRevisionHistory`: version history is a document-link setting; a project link has no single
 *   document whose versions a recipient could browse.
 *
 * Both endpoints return the same envelope, which is what makes one component possible — see the
 * header of `src/app/api/projects/[projectSlug]/shareviews/route.ts`.
 */
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { funnelSurface, trackFunnel } from "@/lib/client/funnel";
import {
  ClipboardDocumentCheckIcon,
  DocumentTextIcon,
  FolderIcon,
  LinkIcon,
  Square2StackIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import RecentVisitors, {
  type RecentVisitor,
} from "@/components/metrics/RecentVisitors";
import { viewerRouteKey } from "@/components/metrics/ViewerProfile";
import DepthBadge, {
  ReadingLegendButton,
} from "@/components/metrics/DepthBadge";
import ProjectHeaderActions from "@/components/project/ProjectHeaderActions";
import DocHeaderActions from "@/components/doc/DocHeaderActions";
import DocReplaceFileButton from "@/components/doc/DocReplaceFileButton";
import DocIdentityRow from "@/components/doc/DocIdentityRow";
import ProjectIdentityRow from "@/components/project/ProjectIdentityRow";
import Modal from "@/components/modals/Modal";
import Button from "@/components/ui/Button";
import { mergeSilentRefresh } from "@/lib/client/metricsPayload";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { usePlan } from "@/lib/client/usePlan";
import {
  Area,
  AreaChart,
  CartesianGrid,
  LabelList,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDayKey } from "@/lib/format/date";
import { valueLabels } from "@/components/charts/ChartValueLabel";
import { buildPublicProjectUrl, buildPublicShareUrl } from "@/lib/urls";
import {
  type RealtimeState,
  realtimeState,
  subscribeRealtime,
} from "@/lib/client/realtime";
import { rememberEntityTitle } from "@/lib/client/entityTitles";
import EntityCrumbLabel, {
  CrumbSkeleton,
  EntityHeaderName,
  useHeaderName,
} from "@/components/HeaderIdentity";
import { useEntityIdentity } from "@/lib/client/entityIdentity";

/** Free = basic (totals, chart, unique viewer count); Pro = deep (identities, per-page time, visits). */
type AnalyticsTier = "basic" | "deep";

/** Mirror of `AnalyticsTeaser` in `src/lib/analytics/teaser.ts`: lifetime counts, first view, hidden days. */
type AnalyticsTeaser = {
  uniqueViewers: number;
  identifiedViewers: number;
  firstViewAt: string | null;
  hiddenDays: number;
};

/**
 * Which resource's metrics these are. Built by the two page shells (`docMetricsScope` /
 * `projectMetricsScope` below) so no call site can pair an API base with the wrong noun.
 */
export type MetricsScope = {
  kind: "doc" | "project";
  id: string;
  /** Title case, for the breadcrumb root and the fallback header title. */
  noun: string;
  /** Lower case, mid-sentence: "this document" / "this project". */
  nounLower: string;
  /** `/doc/<id>` or `/project/<id>`. */
  basePath: string;
  /** `/api/docs/<id>` or `/api/projects/<id>`. */
  apiBase: string;
  /** Per-page time and per-visit timelines — documents only. */
  supportsPageDetail: boolean;
  /** The "Version history" setting in the scoped link's settings row — documents only. */
  showRevisionHistory: boolean;
  /** The absolute public URL of a link of this resource. */
  publicUrl: (shareId: string) => string;
};

/** The document scope: `/doc/:docId/metrics`. */
export function docMetricsScope(docId: string): MetricsScope {
  return {
    kind: "doc",
    id: docId,
    noun: "Document",
    nounLower: "document",
    basePath: `/doc/${encodeURIComponent(docId)}`,
    apiBase: `/api/docs/${encodeURIComponent(docId)}`,
    supportsPageDetail: true,
    showRevisionHistory: true,
    publicUrl: buildPublicShareUrl,
  };
}

/** The project scope: `/project/:projectId/metrics`. */
export function projectMetricsScope(projectId: string): MetricsScope {
  return {
    kind: "project",
    id: projectId,
    noun: "Project",
    nounLower: "project",
    basePath: `/project/${encodeURIComponent(projectId)}`,
    apiBase: `/api/projects/${encodeURIComponent(projectId)}`,
    supportsPageDetail: false,
    showRevisionHistory: false,
    publicUrl: buildPublicProjectUrl,
  };
}

type MetricsResponse = {
  ok: true;
  /** The resource's name, so the header needs no second fetch. One of the two is always present. */
  docTitle?: string;
  projectName?: string;
  days: number;
  /** Present when the workspace plan clamps the analytics window (Free = 7 days). */
  analyticsDaysLimit?: number;
  /** Which tier the server rendered; on `"basic"` the viewer arrays are empty and per-page maps are omitted. */
  analyticsTier?: AnalyticsTier;
  /**
   * Basic only: the real shape of what the plan withholds, as counts and one date. Older servers
   * omit it; the viewer block then falls back to the window count alone.
   */
  teaser?: AnalyticsTeaser;
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
    /** Document scope: distinct pages reached. */
    pagesViewed?: number;
    /** Project scope: distinct documents recipients opened through the project's links. */
    docsOpened?: number;
    /**
     * Project scope: arrivals on `/p/:shareId`, counted per tab session. A project link has a
     * landing page, so arriving and opening are separate events — see the route's `LandingRollup`.
     */
    landings?: number;
    /** Project scope: visitors who reached the file list and opened nothing. Absent ≠ zero. */
    landedWithoutOpening?: number;
    /**
     * Opens the owner generated themselves. Recorded, excluded from every other figure here, and
     * printed under the Views card so the exclusion is visible rather than merely correct.
     */
    ownerPreviews?: number;
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
  deletedLinkResidual?: {
    count: number;
    viewers: number;
    downloads: number;
  } | null;
  /**
   * Document scope: readings that came in through a project link — the data room's front door,
   * which has one slug for every document inside it. Deliberately *not* part of `totals`: a
   * project link belongs to the project, and folding its traffic into the document's own figures
   * would make this page, the workspace rollup and `Doc.numberOfViews` disagree. It gets its own
   * card instead, so "who read this?" is never answered with silence.
   *
   * `viewerRows` carry names only on the deep tier; on Basic the server never asks for them.
   */
  projectLinkTraffic?: {
    views: number;
    viewers: number;
    links: Array<{
      shareId: string;
      label: string | null;
      projectId: string | null;
      projectName: string | null;
      href: string | null;
      views: number;
      viewers: number;
      lastViewedAt: string | null;
    }>;
    viewerRows: Array<{
      shareId: string;
      projectId: string | null;
      projectName: string | null;
      views: number;
      /** Distinct pages they reached through the project's link; the badge needs the denominator. */
      pagesViewed?: number;
      timeSpentMs?: number;
      lastViewedAt: string | null;
      /** The pages themselves, so a reader met through two links merges by union, not by sum. */
      pagesSeen?: number[];
      /** `u_<id>` / `a_<digest>` — the key that identifies this reader across links. */
      viewerKey?: string | null;
      /** Their page inside the project that counts this reading, when it can be addressed. */
      viewerHref?: string | null;
      viewerName?: string | null;
      viewerEmail?: string | null;
    }>;
  } | null;
  /**
   * Project scope only: the documents inside the project, ranked by recipients who opened them —
   * the project's analogue of the per-page story a document tells. Bounded server-side
   * (`topDocs=5`), and unlike `byLink` it **follows** `?shareId=`, because "which files did this
   * recipient group open" is exactly the question a single-link view is asking.
   */
  byDoc?: Array<{
    docId: string;
    title: string | null;
    viewers: number;
    lastViewedAt: string | null;
  }>;
  /** Project scope only: live documents in the project, whether or not anyone has opened them. */
  docsTotal?: number;
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
    /** Document scope only — a project link spans documents, so there is no per-page story. */
    pageTimeMsByPage?: Record<string, number>;
    pagesViewed?: number;
    pagesSeen?: number[];
    /** Project scope only: distinct documents this person opened through the project's links. */
    docsOpened?: number;
    /** Project scope only: which documents, longest read first — the drawer's per-page substitute. */
    docs?: Array<{ docId: string; title: string | null; timeSpentMs: number }>;
    /** Project scope only: distinct tab sessions, de-duplicated across the documents in each. */
    sessions?: number;
    /**
     * Project scope only: they arrived and opened nothing. Their row comes from the arrival
     * record rather than from any reading, so every figure beside it is legitimately zero.
     */
    openedNothing?: boolean;
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
    /** Project scope only: distinct documents this device opened through the project's links. */
    docsOpened?: number;
    docs?: Array<{ docId: string; title: string | null; timeSpentMs: number }>;
    sessions?: number;
    /** See `viewers[].openedNothing`. */
    openedNothing?: boolean;
    firstSeen: string | null;
    lastSeen: string | null;
  }>;
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** "12 Sep 2026" for the scoped link's expiry — `formatDateTime` above is for viewer timestamps. */
function formatDateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** "3h ago" / "12 Sep" for the LINKS card's mini lists, matching `QuickStats`. */
export function relativeAge(iso: string | null): string {
  if (!iso) return "–";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "–";
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

/**
 * The right-hand count line on a viewer row — one component so the list and its "See more" modal
 * cannot drift apart, and so the project rule below is stated once.
 *
 * On a **document** these are two different facts: how many times someone came, and how much of the
 * deck they reached. On a **project** they are not. A project `ShareView` row is one (viewer,
 * document) pair (docs/METRICS.md, "Project links: how a data-room visit is keyed"), so the row
 * count *is* the document count, and printing both produced "1 views · 1 document" — the same fact
 * twice, the first time under the wrong name, which invites a reader to add them up. The project
 * row therefore prints the documents alone: the honest quantity, once.
 */
function ViewerCounts({
  views,
  pagesViewed,
  docsOpened,
  openedNothing,
  supportsPageDetail,
}: {
  views: number;
  pagesViewed?: number;
  docsOpened?: number;
  /** The server says so, rather than the row inferring it from a zero it cannot interpret. */
  openedNothing?: boolean;
  supportsPageDetail: boolean;
}) {
  if (supportsPageDetail) {
    return (
      <>
        {views} views
        {typeof pagesViewed === "number" ? <> · {pagesViewed} pages</> : null}
      </>
    );
  }
  // `views` is the fallback for a response written before `docsOpened` existed: on this scope the
  // two are the same number, so the row is still right, only less explicit.
  const n = typeof docsOpened === "number" ? docsOpened : views;
  // Someone who arrived and read nothing. "0 documents" is true and reads like a missing value;
  // this says what actually happened, which on a data room is a result rather than an absence.
  // `openedNothing` is the server saying it, so a payload that simply did not compute `docsOpened`
  // cannot be mistaken for a visitor who read nothing.
  if (openedNothing || n === 0) return <>Opened nothing yet</>;
  return (
    <>
      {n} {n === 1 ? "document" : "documents"}
    </>
  );
}

export function formatShortId(
  id: string | null | undefined,
  { head = 4, tail = 4 }: { head?: number; tail?: number } = {},
): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return "";
  if (raw.length <= head + tail + 1) return raw;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
}

export function formatPageRanges(pages: number[]): string {
  const sorted = Array.from(
    new Set(
      pages.filter(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 1,
      ),
    ),
  )
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

export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

export function formatDurationShort(msRaw: number | null | undefined): string {
  const ms =
    typeof msRaw === "number" && Number.isFinite(msRaw)
      ? Math.max(0, Math.floor(msRaw))
      : 0;
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
  const ms =
    typeof msRaw === "number" && Number.isFinite(msRaw)
      ? Math.max(0, Math.floor(msRaw))
      : 0;
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
  const safeValues = values.map((v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0,
  );
  const data = series.map((s, idx) => ({
    date: s.date,
    value: safeValues[idx] ?? 0,
  }));
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
          <AreaChart
            width={size.w}
            height={size.h}
            data={data}
            margin={{ top: 18, right: 8, bottom: 4, left: 8 }}
          >
            <defs>
              <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={stroke}
                  stopOpacity={fillStops.topOpacity}
                />
                <stop
                  offset="100%"
                  stopColor={stroke}
                  stopOpacity={fillStops.bottomOpacity}
                />
              </linearGradient>
            </defs>

            <YAxis hide domain={[0, "dataMax"]} />
            <CartesianGrid
              stroke="var(--border)"
              strokeOpacity={0.18}
              vertical={false}
            />
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
              formatter={(v: any) => [
                typeof v === "number" ? v.toLocaleString() : String(v),
                "",
              ]}
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
              <LabelList
                dataKey="value"
                content={valueLabels({ values: safeValues })}
              />
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
            const shift =
              n > 1 && i === 0 ? "0%" : n > 1 && i === n - 1 ? "-100%" : "-50%";
            return (
              <span
                key={`tick:${s.date}`}
                className="absolute top-0 whitespace-nowrap"
                style={{ left: `${pct}%`, transform: `translateX(${shift})` }}
              >
                {formatDayKey(s.date)}
              </span>
            );
          });
        })()}
      </div>
    </div>
  );
}

/**
 * Time on each page for one viewer: a smooth area across page numbers with the seconds printed on the
 * pages that matter, the same chart language as the Views chart. Unseen pages sit at zero.
 */
export function PageTimeChart({
  pages,
  msByPage,
}: {
  pages: number[];
  msByPage: Record<string, number>;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxPage = Math.max(1, ...pages);
  const data = Array.from({ length: maxPage }, (_, i) => {
    const raw = msByPage[String(i + 1)];
    return {
      page: i + 1,
      ms:
        typeof raw === "number" && Number.isFinite(raw)
          ? Math.max(0, Math.floor(raw))
          : 0,
    };
  });
  const interval = Math.max(0, Math.ceil(data.length / 12) - 1);
  return (
    <div ref={wrapRef} className="h-36 w-full">
      {width > 0 ? (
        <AreaChart
          width={width}
          height={144}
          data={data}
          margin={{ top: 18, right: 10, bottom: 0, left: 10 }}
        >
          <defs>
            <linearGradient
              id="lnkdrpViewerPageTime"
              x1="0"
              x2="0"
              y1="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="var(--chart-views)"
                stopOpacity={0.24}
              />
              <stop
                offset="100%"
                stopColor="var(--chart-views)"
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, "dataMax"]} />
          <CartesianGrid
            stroke="var(--border)"
            strokeOpacity={0.18}
            vertical={false}
          />
          <XAxis
            dataKey="page"
            interval={interval}
            tickLine={false}
            axisLine={false}
            height={18}
            tick={{ fontSize: 10, fill: "var(--muted-2)" }}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)", strokeOpacity: 0.35 }}
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--fg)",
            }}
            labelStyle={{ color: "var(--muted-2)" }}
            labelFormatter={(label: unknown) => `Page ${String(label ?? "")}`}
            formatter={(v: unknown) => [
              typeof v === "number" && v > 0
                ? formatDurationShort(v)
                : "Not viewed",
              "",
            ]}
          />
          <Area
            type="monotone"
            dataKey="ms"
            stroke="var(--chart-views)"
            strokeWidth={1.5}
            fill="url(#lnkdrpViewerPageTime)"
            fillOpacity={1}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 1.5 }}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="ms"
              content={valueLabels({
                values: data.map((d) => d.ms),
                format: (n) => formatDurationTiny(n),
              })}
            />
          </Area>
        </AreaChart>
      ) : null}
    </div>
  );
}

/** "Viewed 9 pages in 29s over 2 sessions, most time on page 3." — the one-line read of a viewer. */
export function viewerSummary(
  pagesViewed: number,
  timeMs: number,
  sessions: number,
  msByPage: Record<string, number>,
): string {
  const parts = [
    `Viewed ${pagesViewed} ${pagesViewed === 1 ? "page" : "pages"}`,
  ];
  if (timeMs > 0) parts.push(`in ${formatDurationShort(timeMs)}`);
  let text = parts.join(" ");
  if (sessions > 1) text += ` over ${sessions} sessions`;
  const entries = Object.entries(msByPage).filter(
    ([, v]) => typeof v === "number" && v > 0,
  ) as Array<[string, number]>;
  if (entries.length >= 2) {
    const [topPage, topMs] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const avg = entries.reduce((sum, [, v]) => sum + v, 0) / entries.length;
    if (topMs >= avg * 1.5) text += `, most time on page ${topPage}`;
  }
  return `${text}.`;
}

/**
 * {@link viewerSummary} at project scale: the same sentence, with documents where the document
 * version has pages.
 *
 * "Opened 2 documents in 41s over 1 session, most time on the One Pager" is the line a data room's
 * owner actually wants — which file held them — and it is the closest thing a project has to "most
 * time on page 3". The "most time on" clause appears under the same rule: only when the top
 * document is at least half again the mean, so it names a real preference rather than a rounding.
 */
export function projectViewerSummary(
  docs: Array<{ title: string | null; timeSpentMs: number }>,
  timeMs: number,
  sessions: number,
): string {
  const n = docs.length;
  // Arrived and opened nothing. "Opened 0 documents in 0s" is arithmetic; this is the sentence a
  // sender can act on, and on a data room it is a real and common outcome rather than an edge case.
  if (n === 0) {
    const visits = sessions > 1 ? ` over ${sessions} visits` : "";
    return `Opened the room${visits} and no documents yet`;
  }
  const parts = [`Opened ${n} ${n === 1 ? "document" : "documents"}`];
  if (timeMs > 0) parts.push(`in ${formatDurationShort(timeMs)}`);
  let text = parts.join(" ");
  if (sessions > 1) text += ` over ${sessions} sessions`;
  const timed = docs.filter((d) => d.timeSpentMs > 0 && d.title);
  if (timed.length >= 2) {
    const top = timed.reduce((a, b) => (b.timeSpentMs > a.timeSpentMs ? b : a));
    const avg = timed.reduce((sum, d) => sum + d.timeSpentMs, 0) / timed.length;
    if (top.timeSpentMs >= avg * 1.5) text += `, most time on ${top.title}`;
  }
  return `${text}.`;
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="text-[var(--muted-2)]"
    >
      <path
        d="M6 8l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="text-[var(--muted-2)]"
    >
      <path
        d="M16 6l-7 8-3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/**
 * Free-tier stand-in for the viewer lists.
 *
 * It used to be three blurred placeholder rows under a lock, which read as data and were not.
 * Identities are recorded on Free exactly as on Pro, so the server now sends the real shape of
 * what is withheld (`teaser`: lifetime unique and identified viewer counts, the first view date)
 * and this block says it in one sentence: "3 named people and 5 anonymous readers opened this
 * since 12 Aug." One skeleton row keeps the footprint of a list, so the page does not jump when
 * the rows appear on upgrade. `pending` reserves the same footprint (no prompt) while the plan
 * snapshot is still loading.
 *
 * Without `teaser` (an older server) the sentence falls back to the window count; with nobody at
 * all, the empty state stands alone and there is nothing to upsell.
 */
function LockedViewersBlock({
  pending,
  loading,
  count,
  days,
  teaser,
  linkLabel,
  nounLower,
  onUpgrade,
}: {
  pending: boolean;
  loading: boolean;
  /** Unique viewers in the window (both tiers have it); the fallback when `teaser` is missing. */
  count: number;
  days: number;
  /** Lifetime counts from the server, when it sends them. */
  teaser: AnalyticsTeaser | null;
  /** The selected link, when the page is filtered: the count is that link's, not the resource's. */
  linkLabel: string | null;
  /** "document" / "project": the sentence below names what was (not) opened. */
  nounLower: string;
  onUpgrade: () => void;
}) {
  // This is the only viewer information a Free workspace gets, so it must name what it counted:
  // under a link filter, "no one has viewed this document" is a false statement about the document.
  const subject = linkLabel ?? `this ${nounLower}`;
  const people = (n: number, noun: string, plural: string) => `${n.toLocaleString()} ${n === 1 ? noun : plural}`;
  const sinceDate = teaser?.firstViewAt ? formatDateShort(teaser.firstViewAt) : "";

  const lifetime = teaser ? teaser.uniqueViewers : null;
  const identified = teaser ? teaser.identifiedViewers : 0;
  const anonymous = teaser ? Math.max(0, teaser.uniqueViewers - teaser.identifiedViewers) : 0;
  const nobody = teaser ? teaser.uniqueViewers <= 0 : count <= 0;

  // The funnel's view of this block: once per page load, with the counts the person was shown,
  // so the admin funnel can put "how many readers were they looking at" next to whether they
  // upgraded (pricing plan, Phase 4.2). Only once the numbers are real; never for an empty state.
  const teaserReported = useRef(false);
  useEffect(() => {
    if (pending || loading || !teaser || nobody || teaserReported.current) return;
    teaserReported.current = true;
    trackFunnel("teaser_shown", {
      reason: "analytics_history",
      from: funnelSurface(typeof window !== "undefined" ? window.location.pathname : null),
      uniqueViewers: teaser.uniqueViewers,
      identifiedViewers: teaser.identifiedViewers,
    });
  }, [pending, loading, teaser, nobody]);

  const proLine = "Pro shows who they were, how long they spent on each page, and everything since day one.";

  let countLine: React.ReactNode;
  if (nobody) {
    countLine = teaser
      ? `No one has opened ${subject} yet.`
      : `No one has opened ${subject} in the last ${days} days.`;
  } else if (lifetime !== null && identified > 0) {
    countLine = (
      <>
        <strong className="font-semibold text-[var(--fg)]">{people(identified, "named person", "named people")}</strong>
        {anonymous > 0 ? ` and ${people(anonymous, "anonymous reader", "anonymous readers")}` : ""}
        {` opened ${subject}${sinceDate ? ` since ${sinceDate}` : ""}. ${proLine}`}
      </>
    );
  } else if (lifetime !== null) {
    countLine = `${people(lifetime, "person", "people")} opened ${subject}${sinceDate ? ` since ${sinceDate}` : ""}. ${proLine}`;
  } else {
    countLine = `${people(count, "person", "people")} opened ${subject} in the last ${days} days. ${proLine}`;
  }

  return (
    <section
      className="mt-1"
      aria-label="Viewers"
      aria-busy={pending || loading}
    >
      <div className="text-sm font-semibold text-[var(--fg)]">Viewers</div>
      {pending || loading ? (
        <div
          className="mt-1.5 h-4 w-64 rounded bg-[var(--panel-hover)] motion-safe:animate-pulse"
          aria-hidden="true"
        />
      ) : (
        <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">{countLine}</p>
      )}

      {pending || loading || nobody ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="solid" size="sm" onClick={onUpgrade}>
            Upgrade to Pro
          </Button>
          <Link
            href="/pricing?from=analytics_teaser"
            className="text-xs font-medium text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
          >
            See what is included
          </Link>
        </div>
      )}

      {/* One row of list chrome, so the block keeps the footprint the viewer rows take on Pro and
          the page does not jump on upgrade. Not data, and not styled to look like it. */}
      <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
        <ul aria-hidden="true" className={pending ? "motion-safe:animate-pulse" : ""}>
          <li className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4">
            <div className="min-w-0">
              <div className="h-4 w-40 max-w-full rounded bg-[var(--panel-hover)]" />
              <div className="mt-1.5 h-3 w-56 max-w-full rounded bg-[var(--panel-hover)]" />
            </div>
            <div className="shrink-0">
              <div className="h-3 w-24 rounded bg-[var(--panel-hover)] sm:ml-auto" />
              <div className="mt-1.5 h-3 w-32 rounded bg-[var(--panel-hover)] sm:ml-auto" />
            </div>
          </li>
        </ul>
      </div>
    </section>
  );
}

/**
 * Is this `reading` frame about what is on screen?
 *
 * The realtime server splits a reader's life into two frames: `viewer` for the arrival and for a
 * name (a `shareviews` insert, or a `viewerName` / `viewerEmailSnapshot` write), and `reading` for
 * everything after it, the visit clock, the page clock, the pages reached, a repeat open. This
 * page subscribed to the first and not the second, so an owner watching someone read saw the
 * arrival land and then nothing move for the rest of the session.
 *
 * Same filter as the identity frame, for the same reason: a document page can compare the frame's
 * document with its own, and a project page cannot, because a `ShareView` carries no project (the
 * link does). So the project scope takes every progress frame in the workspace. The server
 * throttles a reader to one frame every few seconds and the debounce below collapses a burst into
 * one refetch, which is what makes that affordable.
 */
export function readingFrameInScope(
  reading: { docId: string | null },
  isProject: boolean,
  scopeId: string,
): boolean {
  if (isProject) return true;
  return !reading.docId || reading.docId === scopeId;
}

/**
 * How long the page may go without asking the server anything, socket or no socket.
 *
 * Two poll periods: long enough that a healthy channel never reaches it, short enough that a
 * frame this page does not understand cannot freeze it for a whole reading session.
 */
export const METRICS_STALE_FLOOR_MS = 60_000;

/**
 * Should the fallback timer refetch on this tick?
 *
 * The guard used to be "socket open, nothing to do", which reads as "the channel delivers
 * everything this page renders". It does not, and never did: the channel delivers the frame types
 * this page happens to subscribe to. So a healthy socket carrying only frames nobody here listened
 * for left the page with no refresh path at all, while a dead socket would have caught the same
 * numbers within half a minute. Realtime working made the page staler than realtime being gone.
 *
 * A floor instead of an either/or. An open channel still suppresses the ordinary tick, so a live
 * page costs nothing extra, but a page that has not been to the server inside
 * `METRICS_STALE_FLOOR_MS` goes anyway and stops guessing why. A hidden tab never polls either
 * way: nobody is looking, and it refetches on `hello` when it comes back.
 */
export function shouldFallbackRefetch(input: {
  realtime: RealtimeState;
  visible: boolean;
  msSinceLastFetch: number;
}): boolean {
  if (!input.visible) return false;
  if (input.realtime !== "open") return true;
  return input.msSinceLastFetch >= METRICS_STALE_FLOOR_MS;
}

/**
 * Render the MetricsPageClient UI (uses effects, local state).
 *
 * Free workspaces get the basic tier: totals, the views-by-day charts and the unique viewer
 * count, with the viewer lists replaced by `LockedViewersBlock`. The visits endpoints answer
 * `402` on Free, so they are never requested unless the tier is deep.
 */
export default function MetricsView({ scope }: { scope: MetricsScope }) {
  const router = useRouter();
  const { kind, noun, nounLower, basePath, apiBase, supportsPageDetail } =
    scope;
  /** Landings, the per-document ranking and the DOCUMENTS card exist only on the project scope. */
  const isProject = kind === "project";
  /**
   * The resource's name for this header.
   *
   * It used to start empty and fill from the metrics payload — which means the name of the thing
   * you are looking at waited on the whole analytics aggregation, and the header showed the word
   * "Document" or "Project" until it landed. The remembered name (`entityTitles`) covers that gap;
   * the payload still overwrites it when it arrives.
   */
  const { name: remembered } = useHeaderName(
    scope.kind === "project" ? "project" : "doc",
    scope.id,
  );
  // The same shared read the header uses, for its page count: coverage needs a denominator.
  const { identity: docIdentity } = useEntityIdentity(
    scope.kind === "project" ? "project" : "doc",
    scope.id,
  );
  const [resourceTitle, setResourceTitle] = useState<string>("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [liveLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveData, setData] = useState<MetricsResponse | null>(null);
  const [liveViewersLoading, setViewersLoading] = useState(false);
  const [liveViewersLoaded, setViewersLoaded] = useState(false);
  /**
   * True only after the first client render.
   *
   * This page renders inside a `Suspense` boundary, so its effects can run *before* React hydrates
   * this subtree. A fetch that resolves in that window flips `loading` or `data` and the first
   * client render stops matching the server's — intermittently, since it depends on whether the
   * response beat hydration, which is why it showed on a warm cache and not a cold one.
   *
   * Every render-time read of the fetched state goes through the gates below, so the first client
   * render is identical to the server's by construction and the real content arrives one paint
   * later. Read `loading`/`data`/`viewers*` directly only inside effects and handlers.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  /** Fetched state as the render may read it: server-shaped until the client has taken over. */
  const data = hydrated ? liveData : null;
  const loading = hydrated ? liveLoading : false;
  const viewersLoading = hydrated ? liveViewersLoading : false;
  const viewersLoaded = hydrated ? liveViewersLoaded : false;

  const [authedViewersModalOpen, setAuthedViewersModalOpen] = useState(false);
  const [anonViewersModalOpen, setAnonViewersModalOpen] = useState(false);
  const [authedViewersModalPage, setAuthedViewersModalPage] = useState(0);
  const [anonViewersModalPage, setAnonViewersModalPage] = useState(0);
  const [days, setDays] = useState(15);
  /**
   * Bumped when someone arrives under this page, or a reader here changes their name (see the
   * realtime effect below). It is a dependency of the loader, so a bump refetches both payloads —
   * the cheapest correct answer, given that either event moves names, counts and groupings at once.
   */
  const [identityNonce, setIdentityNonce] = useState(0);
  /**
   * Whether the refetch now in flight was asked for by the page or by the world.
   *
   * A realtime refresh runs the same loader, and the loader opens by putting the page back into
   * its loading state — which on a live page meant every chart and list blanked to a skeleton each
   * time someone opened the document. The numbers on screen are a few hundred milliseconds stale,
   * not wrong; they stay up, the thin progress bar says work is happening, and the new values
   * replace them in place.
   */
  const silentRefreshRef = useRef(false);
  /**
   * When this page last went to the server, asked or not, answered or not.
   *
   * The staleness floor below measures from here rather than from the last successful payload: a
   * request that failed or 404'd still means the page has just been told what the server thinks,
   * and retrying it every tick would make a broken endpoint into a loop.
   */
  const lastFetchAtRef = useRef(Date.now());
  /**
   * Whether the identities have ever arrived on this page.
   *
   * The strip waits for them before its first paint, so it is drawn once with what it will keep
   * saying. It must not wait again: every refresh clears `viewersLoaded` while the second request
   * is back in flight, and gating on that turned each one into the card vanishing and returning —
   * trading a flicker on load for a flicker every twenty seconds. A latch, not a state.
   */
  const viewersEverLoadedRef = useRef(false);
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
    router.replace(qs ? `?${qs}` : `${basePath}/metrics`, { scroll: false });
  }
  /** Set when a filtered request 404s because the link was deleted elsewhere; the scope then resets. */
  const [filterDroppedNotice, setFilterDroppedNotice] = useState(false);
  /** The scoped link's public URL: what the recipient was actually sent. */
  const publicUrl = useMemo(
    () => (shareId ? scope.publicUrl(shareId) : ""),
    [shareId, scope],
  );
  const [urlCopied, setUrlCopied] = useState(false);

  /** `&shareId=…` for the selected link, or "" for "All links". */
  const linkFilterParam = shareId
    ? `&shareId=${encodeURIComponent(shareId)}`
    : "";
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
    typeof data?.analyticsDaysLimit === "number" &&
    Number.isFinite(data.analyticsDaysLimit) &&
    data.analyticsDaysLimit > 0
      ? Math.floor(data.analyticsDaysLimit)
      : null;
  const rangeOptions = useMemo(
    () =>
      [
        { label: "Last 3 days", value: 3 },
        { label: "Last 7 days", value: 7 },
        { label: "Last 15 days", value: 15 },
        { label: "Last 30 days", value: 30 },
      ].filter(
        (opt) => analyticsDaysLimit === null || opt.value <= analyticsDaysLimit,
      ),
    [analyticsDaysLimit],
  );

  useEffect(() => {
    // Snap the selected range to the plan window so the label and the data agree.
    if (analyticsDaysLimit !== null && days > analyticsDaysLimit)
      setDays(analyticsDaysLimit);
  }, [analyticsDaysLimit, days]);
  // The per-viewer drawer, its visits list and the visit detail modal were removed on 2026-09-25:
  // the only two functions that opened the drawer had no callers since viewer rows became links to
  // the reader page (`/doc/:id/metrics/viewer/...`), so about nine hundred lines of state, loaders
  // and three modals were unreachable (code review 2026-09-23, Low).
  /** Rows in the viewers card before it defers to the full list. */
  const VIEWERS_SHOWN = 8;
  const VIEWERS_PAGE_SIZE = 25;

  // Doc title now comes back as part of /shareviews to avoid an extra API call on load.

  useEffect(() => {
    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target))
        setRangeOpen(false);
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
      // A live refresh keeps what is on screen; only a first load or a deliberate change (a new
      // range, a different link) is allowed to take the page back to skeletons.
      const silent = silentRefreshRef.current;
      silentRefreshRef.current = false;
      lastFetchAtRef.current = Date.now();
      if (!silent) setLoading(true);
      setError(null);
      setViewersLoading(false);
      if (!silent) setViewersLoaded(false);
      try {
        const res = await fetchWithTempUser(
          // `byLink=1&topLinks=5`, unconditionally: the ranking and `linksTotal` are document-wide
          // regardless of `?shareId=` (the route computes them from `docScopeMatch`, not `scopeMatch`),
          // and bounded, so asking for them even on a single-link view costs nothing worth skipping.
          // `byDoc=1` is project-only: the document route has no such ranking, and asking for it
          // there would put an unread parameter on every document metrics request.
          `${apiBase}/shareviews?days=${encodeURIComponent(String(days))}&lite=1&byLink=1&topLinks=5${
            isProject ? "&byDoc=1&topDocs=5" : ""
          }${linkFilterParam}`,
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
        if (
          !json ||
          typeof json !== "object" ||
          !(json as { ok?: unknown }).ok
        ) {
          throw new Error("Invalid response");
        }
        const parsed = json as MetricsResponse;
        // A silent refresh keeps the viewer rows on screen: the lite payload never carries them,
        // and replacing the whole object blanked the list until the viewers request below landed
        // (src/lib/client/metricsPayload.ts).
        setData((prev) => mergeSilentRefresh(prev, parsed, silent));
        // A silent refresh left `viewersLoaded` alone so the list would not blink out; clearing it
        // here, once the new payload is in hand, is what makes the list follow it.
        if (silent) setViewersLoaded(false);
        const t = (
          typeof parsed?.docTitle === "string"
            ? parsed.docTitle
            : (parsed?.projectName ?? "")
        ).trim();
        if (!cancelled && t) {
          setResourceTitle(t);
          rememberEntityTitle(
            scope.kind === "project" ? "project" : "doc",
            scope.id,
            t,
          );
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load metrics");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadMetrics();
    return () => {
      cancelled = true;
    };
  }, [
    apiBase,
    basePath,
    days,
    isProject,
    linkFilterParam,
    router,
    identityNonce,
  ]);

  /**
   * Someone arrived, or someone here renamed themselves — either way the page moves on its own.
   *
   * The arrival is the event this page is left open for: a `shareviews` (or `projectlinkviews`)
   * row is inserted the first time a person opens the link, the realtime server broadcasts it, and
   * the refetch here puts them at the top of Recent visitors while the owner is watching. The
   * rename is the other half: a reader who re-answers "introduce yourself" has their new name
   * written through to their rows (`propagateViewerIdentity`), and "Michael J" becomes "Michael
   * Jay" without a reload.
   *
   * One rename touches every row this person owns here, so the frames arrive in a burst; the
   * timer collapses them into a single refetch. On the project scope the frame's document is not
   * enough to tell whether it is inside this project, so any identity change in the workspace
   * refetches — a rare event, and a stale name is the thing this exists to prevent.
   *
   * The third event is the one this page was missing: somebody is reading, right now. An arrival
   * happens once per (link, reader) and then never again, so a page subscribed to `viewer` alone
   * showed a visitor appear and then froze for the whole of their session, with time spent,
   * per-page time, pages seen and a repeat open all arriving as `reading` frames nothing here
   * listened for. It goes through the same debounce as the rest: the server already caps a reader
   * at one frame every few seconds, and a refetch answers all three events with one request.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      silentRefreshRef.current = true;
      setIdentityNonce((n) => n + 1);
    };
    const bumpSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(bump, 400);
    };
    // A reconnection means a gap: the streams keep no resume token, so anything that happened
    // while this tab was disconnected was never delivered and never will be.
    const offHello = subscribeRealtime("hello", bump);
    const off = subscribeRealtime("viewer", (frame) => {
      if (frame.type !== "viewer") return;
      if (!isProject && frame.viewer.docId && frame.viewer.docId !== scope.id)
        return;
      bumpSoon();
    });
    const offReading = subscribeRealtime("reading", (frame) => {
      if (frame.type !== "reading") return;
      if (!readingFrameInScope(frame.reading, isProject, scope.id)) return;
      bumpSoon();
    });
    return () => {
      if (timer) clearTimeout(timer);
      offHello();
      off();
      offReading();
    };
  }, [isProject, scope.id]);

  /**
   * The fallback for a tab with no socket, and the floor under one that has a socket.
   *
   * Realtime was this page's only refresh path — no poll, no refetch on focus — so a workspace
   * behind a proxy that blocks the upgrade, or a deployment with no realtime host at all, showed
   * numbers frozen at page load with nothing to say so. Only while the tab is visible, so it costs
   * nothing in a background tab.
   *
   * It is not an either/or any more (see `shouldFallbackRefetch`): an open socket suppresses the
   * ordinary tick, but never for longer than `METRICS_STALE_FLOOR_MS`. Trusting "open" to mean
   * "everything is delivered" is what turned a missing subscription into a page with no refresh
   * path at all, and the floor is what stops the next one doing it again.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (
        !shouldFallbackRefetch({
          realtime: realtimeState(),
          visible: document.visibilityState === "visible",
          msSinceLastFetch: Date.now() - lastFetchAtRef.current,
        })
      )
        return;
      silentRefreshRef.current = true;
      setIdentityNonce((n) => n + 1);
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

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
          `${apiBase}/shareviews?days=${encodeURIComponent(String(days))}&viewers=1&viewersOnly=1${linkFilterParam}`,
          { cache: "no-store" },
        );
        // Settled either way: "we asked and this is all there is" is what the flag has to mean,
        // or a failed request leaves every surface waiting on it blank for the life of the page.
        if (!res.ok) {
          if (!cancelled) {
            setViewersLoaded(true);
            viewersEverLoadedRef.current = true;
          }
          return;
        }
        const json = (await res.json().catch(() => null)) as any;
        if (cancelled) return;
        if (!json || typeof json !== "object" || json.ok !== true) {
          setViewersLoaded(true);
          viewersEverLoadedRef.current = true;
          return;
        }
        setData((prev) => {
          if (!prev || typeof prev !== "object") return prev as any;
          const next = { ...(prev as any) };
          next.totals = {
            ...(prev as any).totals,
            authenticatedViewers:
              typeof json?.totals?.authenticatedViewers === "number"
                ? json.totals.authenticatedViewers
                : ((prev as any)?.totals?.authenticatedViewers ?? 0),
            anonymousViewers:
              typeof json?.totals?.anonymousViewers === "number"
                ? json.totals.anonymousViewers
                : ((prev as any)?.totals?.anonymousViewers ?? 0),
          };
          next.viewers = Array.isArray(json.viewers) ? json.viewers : [];
          next.anonymousViewers = Array.isArray(json.anonymousViewers)
            ? json.anonymousViewers
            : [];
          // This response is the one that asked for identities, so its project-link rows carry
          // names where the first (lite) payload's could not. Take it whenever it is present.
          if (json.projectLinkTraffic)
            next.projectLinkTraffic = json.projectLinkTraffic;
          return next as MetricsResponse;
        });
        setViewersLoaded(true);
        viewersEverLoadedRef.current = true;
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
  }, [apiBase, days, linkFilterParam, data, deepAnalytics]);

  /**
   * The selected link's own label, or `null` while the payload that carries it is still out.
   *
   * Name slots — the breadcrumb, the line under the link's address — take this one and wait when it
   * is null, because "this link" is a phrase for a sentence, not something anyone named a link.
   */
  const selectedLinkName = useMemo(
    () => (shareId ? (data?.link?.label ?? null) : null),
    [shareId, data],
  );
  /**
   * What a name slot shows for the link: its label, a pulse while the payload is out, and the bare
   * noun once it has come back without one — a request that failed must not leave a bar pulsing at
   * the top of the page forever.
   */
  const selectedLinkSlot =
    selectedLinkName ?? (data || error ? "Link" : <CrumbSkeleton />);
  /** The same label for prose, where a sentence still has to say *something* about its subject. */
  const selectedLinkLabel = shareId ? (selectedLinkName ?? "this link") : null;

  /**
   * The "LINKS" card's two lists: which links are pulling the traffic, and which are live right
   * now — ranked over `data.byLink`, the bounded top-5-by-views ∪ top-5-by-recency the server
   * already sent, never a fetch of every link. Only rendered in master mode (`!shareId`): under a
   * single-link filter this ranking would be comparing the very link the page is already about
   * against the others, which is a different question than the one this card answers.
   */
  const topLinksByViewers = useMemo(
    () =>
      [...(data?.byLink ?? [])]
        .sort((a, b) => b.viewers - a.viewers || b.views - a.views)
        .slice(0, 3),
    [data],
  );
  /** Longest bar = 100%, so the bars read relative to each other, not to some absolute scale. */
  const maxTopLinkViewers = useMemo(
    () => Math.max(1, ...topLinksByViewers.map((r) => r.viewers)),
    [topLinksByViewers],
  );
  /**
   * The recent-visitor strip's rows: named viewers and anonymous ones in one list, newest first.
   *
   * Both come from the same payload the viewer tables below use, so there is no second request and
   * no second definition of who counts as a viewer. What each row can honestly say differs by
   * scope — a project link spans documents, so it reports documents opened where a document
   * reports pages read.
   */
  /**
   * The denominator for coverage: how many pages this document has. Documents only — a project's
   * unit is documents opened, which has no fixed total worth dividing by.
   */
  const docTotalPages =
    scope.kind === "doc" ? (docIdentity?.pages ?? null) : null;

  /**
   * Every reader of this resource in one list: signed in, anonymous, and arrived through a project.
   *
   * The three were separate sections with separate explanations, which pushed the merging onto the
   * reader — and made "who read this?" answerable three different ways depending on where you were
   * looking. What actually differs between them is carried on the row instead: whether a name is
   * known, the depth badge, and the project chip.
   */
  /**
   * Every reader of this resource, one row per person — whichever links they used.
   *
   * Both lists on this page read from here, which is the point. They were two builders walking the
   * same three arrays, and they drifted: the strip forgot to pass the document's page count, so the
   * same reading was READ in one list and STARTED in the other.
   *
   * Merging matters beyond tidiness. A recipient sent a data room and then a direct link to one
   * file in it writes rows under two keys — a project row is stored as `<digest>.<docId>`, a
   * document row as the bare `<digest>` — and the document's figures deliberately exclude project
   * slugs (`docScope.ts`). Left alone, one person appears twice, under the same name, with two
   * different verdicts and two different destinations, on the page built to answer "who read
   * this?". They are one person here, keyed by user id, then email, then device digest, with their
   * pages unioned rather than added: someone who read pages 1-3 through both links read three
   * pages, not six.
   */
  const people = useMemo(() => {
    type Person = {
      key: string;
      name: string | null;
      email: string | null;
      views: number;
      timeMs: number;
      /** Doc scope: the pages themselves, so two reads merge by union. Project scope: unused. */
      pages: Set<number>;
      /** Doc scope, when only a count came back. Project scope: documents opened. */
      pageCount: number;
      firstSeen: string | null;
      lastSeen: string | null;
      /** The projects they came through, if any — one chip each, deduped. */
      vias: Array<{ name: string; href: string | null }>;
      /** Their page here, preferred over a project's when they read this document's own links. */
      href: string | null;
      /** Their page inside a project, used when this document has nothing of its own to show. */
      viaViewerHref: string | null;
      openedNothing: boolean;
    };
    const byKey = new Map<string, Person>();
    const blank = (key: string): Person => ({
      key,
      name: null,
      email: null,
      views: 0,
      timeMs: 0,
      pages: new Set<number>(),
      pageCount: 0,
      firstSeen: null,
      lastSeen: null,
      vias: [],
      href: null,
      viaViewerHref: null,
      openedNothing: false,
    });
    /**
     * Who this row belongs to, across links and devices.
     *
     * Signed in, they are their account. Otherwise an email joins the same person on two devices —
     * the identity a sender actually recognises, and the same rule the workspace list uses. Failing
     * both, the browser digest, which is per-device by construction.
     */
    const identify = (
      userId?: string | null,
      email?: string | null,
      digest?: string | null,
    ): string | null => {
      const id = (userId ?? "").trim();
      if (id) return `u:${id}`;
      const mail = (email ?? "").trim().toLowerCase();
      if (mail) return `e:${mail}`;
      const key = (digest ?? "").trim();
      return key ? `a:${key}` : null;
    };
    const absorb = (
      key: string,
      patch: Partial<Person> & { pagesSeen?: number[] | null },
    ) => {
      const p = byKey.get(key) ?? blank(key);
      p.name = p.name || patch.name || null;
      p.email = p.email || patch.email || null;
      p.views += patch.views ?? 0;
      p.timeMs += patch.timeMs ?? 0;
      for (const page of patch.pagesSeen ?? [])
        if (Number.isFinite(page)) p.pages.add(Math.floor(page));
      p.pageCount = Math.max(p.pageCount, patch.pageCount ?? 0);
      if (patch.firstSeen && (!p.firstSeen || patch.firstSeen < p.firstSeen))
        p.firstSeen = patch.firstSeen;
      if (patch.lastSeen && (!p.lastSeen || patch.lastSeen > p.lastSeen))
        p.lastSeen = patch.lastSeen;
      for (const via of patch.vias ?? [])
        if (!p.vias.some((v) => v.name === via.name)) p.vias.push(via);
      p.href = p.href ?? patch.href ?? null;
      p.viaViewerHref = p.viaViewerHref ?? patch.viaViewerHref ?? null;
      p.openedNothing = p.openedNothing || Boolean(patch.openedNothing);
      byKey.set(key, p);
    };

    for (const v of data?.viewers ?? []) {
      const key = identify(v.userId, v.email, null);
      if (!key) continue;
      absorb(key, {
        name: (v.name ?? "").trim() || null,
        email: (v.email ?? "").trim() || null,
        views: v.views ?? 0,
        timeMs: v.timeSpentMs ?? 0,
        pagesSeen: scope.kind === "project" ? null : (v.pagesSeen ?? null),
        pageCount:
          scope.kind === "project"
            ? (v.docsOpened ?? 0)
            : (v.pagesViewed ?? v.pagesSeen?.length ?? 0),
        lastSeen: v.lastSeen,
        openedNothing: Boolean(v.openedNothing),
        href: `${basePath}/metrics/viewer/${viewerRouteKey("authed", v.userId)}`,
      });
    }

    for (const v of data?.anonymousViewers ?? []) {
      const key = identify(null, v.email, v.botIdHash);
      if (!key) continue;
      absorb(key, {
        name: (v.name ?? "").trim() || null,
        email: (v.email ?? "").trim() || null,
        views: v.views ?? 0,
        timeMs: v.timeSpentMs ?? 0,
        pagesSeen: scope.kind === "project" ? null : (v.pagesSeen ?? null),
        pageCount:
          scope.kind === "project"
            ? (v.docsOpened ?? 0)
            : (v.pagesViewed ?? v.pagesSeen?.length ?? 0),
        firstSeen: v.firstSeen ?? null,
        lastSeen: v.lastSeen,
        openedNothing: Boolean(v.openedNothing),
        href: `${basePath}/metrics/viewer/${viewerRouteKey("anon", v.botIdHash)}`,
      });
    }

    /**
     * Readers who came through a project link belong in this list too.
     *
     * Their reads are attributed to the project, which is why they are absent from `viewers` — but
     * "who read this document" answered without them is a lie by omission: Tester Dude read this
     * deck, through a project, and was nowhere on its page. The chip says where the reading is
     * counted; the row is still one person.
     */
    for (const v of data?.projectLinkTraffic?.viewerRows ?? []) {
      // `u_<id>` / `a_<digest>` — the same digest a document link stores bare, so the two halves
      // of one reader meet here rather than becoming two rows.
      const routeKey = (v.viewerKey ?? "").trim();
      const key =
        identify(
          routeKey.startsWith("u_") ? routeKey.slice(2) : null,
          v.viewerEmail,
          routeKey.startsWith("a_") ? routeKey.slice(2) : null,
        ) ?? `p:${v.shareId}`;
      absorb(key, {
        name: (v.viewerName ?? "").trim() || null,
        email: (v.viewerEmail ?? "").trim() || null,
        views: v.views ?? 0,
        timeMs: v.timeSpentMs ?? 0,
        pagesSeen: scope.kind === "project" ? null : (v.pagesSeen ?? null),
        pageCount: scope.kind === "project" ? 0 : (v.pagesViewed ?? 0),
        lastSeen: v.lastViewedAt,
        vias: [
          {
            name: v.projectName || "Project",
            href: v.projectId
              ? `/project/${encodeURIComponent(v.projectId)}/metrics`
              : null,
          },
        ],
        viaViewerHref: v.viewerHref ?? null,
      });
    }

    return [...byKey.values()]
      .map((p) => ({
        ...p,
        /** Pages actually reached, unioned where the arrays came back and counted where they did not. */
        pagesViewed: p.pages.size > 0 ? p.pages.size : p.pageCount,
      }))
      .sort(
        (a, b) =>
          new Date(b.lastSeen ?? 0).getTime() -
          new Date(a.lastSeen ?? 0).getTime(),
      );
  }, [
    data?.viewers,
    data?.anonymousViewers,
    data?.projectLinkTraffic,
    scope.kind,
    basePath,
  ]);

  /** Every reader in one table, newest first — the list under the charts. */
  const allViewerRows = useMemo(() => {
    const countsLine = (views: number, pages: number | null, timeMs: number) =>
      [
        `${views.toLocaleString()} ${views === 1 ? "view" : "views"}`,
        pages && pages > 0
          ? scope.kind === "project"
            ? `${pages} ${pages === 1 ? "document" : "documents"}`
            : `${pages} ${pages === 1 ? "page" : "pages"}`
          : null,
        timeMs > 0 ? formatDurationShort(timeMs) : null,
      ]
        .filter(Boolean)
        .join(" · ");

    return people.map((p) => {
      const title =
        p.name ||
        p.email ||
        (p.key.startsWith("u:") ? "Signed-in user" : "Anonymous viewer");
      return {
        key: p.key,
        title,
        subtitle:
          p.email && title !== p.email
            ? p.email
            : p.firstSeen
              ? `First seen ${formatDateTime(p.firstSeen)}`
              : null,
        stats: countsLine(p.views, p.pagesViewed, p.timeMs),
        timeMs: p.timeMs,
        pages: p.pagesViewed,
        lastSeen: p.lastSeen,
        vias: p.vias,
        href: p.href ?? p.viaViewerHref ?? p.vias[0]?.href ?? null,
        hint: p.href || p.viaViewerHref ? "See what they read" : undefined,
      };
    });
  }, [people, scope.kind]);

  /** The same people, shaped for the strip at the top of the page. */
  const recentVisitors = useMemo(
    (): RecentVisitor[] =>
      people.map((p) => {
        const parts: string[] = [];
        if (p.openedNothing) parts.push("opened nothing");
        else if (p.pagesViewed > 0) {
          parts.push(
            scope.kind === "project"
              ? `${p.pagesViewed} ${p.pagesViewed === 1 ? "document" : "documents"}`
              : `${p.pagesViewed} ${p.pagesViewed === 1 ? "page" : "pages"}`,
          );
        }
        if (p.timeMs > 0) parts.push(formatDurationShort(p.timeMs));
        return {
          key: p.key,
          name: p.name || p.email || null,
          lastSeen: p.lastSeen,
          detail: parts.length ? parts.join(" · ") : null,
          timeMs: p.timeMs,
          pages: p.pagesViewed,
          totalPages: docTotalPages,
          vias: p.vias,
          href: p.href ?? p.viaViewerHref ?? p.vias[0]?.href ?? null,
          hint: p.href || p.viaViewerHref ? "See what they read" : undefined,
        };
      }),
    [people, scope.kind, docTotalPages],
  );

  const recentlyOpenedLinks = useMemo(
    () =>
      [...(data?.byLink ?? [])]
        .filter((r) => Boolean(r.lastViewedAt))
        .sort(
          (a, b) => Date.parse(b.lastViewedAt!) - Date.parse(a.lastViewedAt!),
        )
        .slice(0, 3),
    [data],
  );

  /**
   * The "DOCUMENTS" card's two lists — the project's answer to the per-page breakdown a document
   * has. Same shape and same bars as the links lists directly above it on purpose: a reader who
   * has just learned to read one of them can read the other without being taught twice.
   *
   * Unlike the links lists this one survives a `?shareId=` filter (see `byDoc` above).
   */
  const topDocsByViewers = useMemo(
    () =>
      [...(data?.byDoc ?? [])]
        .sort((a, b) => b.viewers - a.viewers)
        .slice(0, 3),
    [data],
  );
  const maxTopDocViewers = useMemo(
    () => Math.max(1, ...topDocsByViewers.map((r) => r.viewers)),
    [topDocsByViewers],
  );
  const recentlyOpenedDocs = useMemo(
    () =>
      [...(data?.byDoc ?? [])]
        .filter((r) => Boolean(r.lastViewedAt))
        .sort(
          (a, b) => Date.parse(b.lastViewedAt!) - Date.parse(a.lastViewedAt!),
        )
        .slice(0, 3),
    [data],
  );

  const views = data?.totals?.views ?? 0;
  /**
   * Visitors who reached the project page and opened nothing (project scope only).
   *
   * `null`, not `0`, whenever the figure did not come back — an old response, a document scope, or
   * the `viewersOnly=1` follow-up that never computes it. The clause is then omitted rather than
   * printed as a zero: the tile must not assert "0 landed without opening" on a response that
   * simply never asked.
   */
  const landedWithoutOpening =
    isProject && typeof data?.totals?.landedWithoutOpening === "number"
      ? Math.max(0, Math.floor(data.totals.landedWithoutOpening))
      : null;
  /** Tab sessions in the window: opens, not recipients. `null` on a response from before it existed. */
  const opens =
    typeof data?.totals?.opens === "number" && data.totals.opensPartial !== true
      ? Math.max(0, Math.floor(data.totals.opens))
      : null;
  const downloads = data?.totals?.downloads ?? 0;
  // `totals.downloads` is omitted by viewers-only responses: undefined means "not loaded", not zero.
  const downloadsKnown = typeof data?.totals?.downloads === "number";
  /**
   * The "how much of it was reached" figure, whichever the scope has: distinct pages for a
   * document, distinct documents for a project. One variable, because the tile prints it in one
   * place and only the noun beside it changes.
   */
  const pagesViewed =
    (supportsPageDetail
      ? data?.totals?.pagesViewed
      : data?.totals?.docsOpened) ?? 0;
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
  const anonymousViewersList = Array.isArray(data?.anonymousViewers)
    ? data!.anonymousViewers
    : [];
  /**
   * Readings that arrived through a project link. Kept out of every total on this page on purpose
   * (see the field's comment on `MetricsResponse`) — which is exactly why it has to be *said*
   * somewhere, or a named person reading this document through a data room shows up in the
   * activity feed and nowhere here.
   */
  const projectLinkTraffic = data?.projectLinkTraffic ?? null;
  const chartSeries = series.map((s) => ({ date: s.date }));
  const viewsSeries = series.map((s) =>
    typeof s.views === "number" && Number.isFinite(s.views) ? s.views : 0,
  );
  const downloadsSeries = series.map((s) =>
    typeof s.downloads === "number" && Number.isFinite(s.downloads)
      ? s.downloads
      : 0,
  );

  const authedViewersList = Array.isArray(data?.viewers) ? data!.viewers : [];
  const authedViewersTop = authedViewersList.slice(0, 5);
  const anonViewersTop = anonymousViewersList.slice(0, 5);

  const authedModalTotal = authedViewersList.length;
  const authedModalPages = Math.max(
    1,
    Math.ceil(authedModalTotal / VIEWERS_PAGE_SIZE),
  );
  const authedModalPageSafe = Math.min(
    Math.max(0, authedViewersModalPage),
    authedModalPages - 1,
  );
  const authedModalStart = authedModalTotal
    ? authedModalPageSafe * VIEWERS_PAGE_SIZE
    : 0;
  const authedModalEnd = authedModalTotal
    ? Math.min(authedModalStart + VIEWERS_PAGE_SIZE, authedModalTotal)
    : 0;
  const authedModalItems = authedViewersList.slice(
    authedModalStart,
    authedModalEnd,
  );

  const anonModalTotal = anonymousViewersList.length;
  const anonModalPages = Math.max(
    1,
    Math.ceil(anonModalTotal / VIEWERS_PAGE_SIZE),
  );
  const anonModalPageSafe = Math.min(
    Math.max(0, anonViewersModalPage),
    anonModalPages - 1,
  );
  const anonModalStart = anonModalTotal
    ? anonModalPageSafe * VIEWERS_PAGE_SIZE
    : 0;
  const anonModalEnd = anonModalTotal
    ? Math.min(anonModalStart + VIEWERS_PAGE_SIZE, anonModalTotal)
    : 0;
  const anonModalItems = anonymousViewersList.slice(
    anonModalStart,
    anonModalEnd,
  );

  const dateRangeLabel = useMemo(() => {
    if (!series.length) return `Last ${days} days`;
    const first = series[0]?.date ?? "";
    const last = series[series.length - 1]?.date ?? "";
    return first && last ? `${first} → ${last}` : `Last ${days} days`;
  }, [series, days]);

  // Keep modal pagination in-bounds if the list size changes.
  useEffect(() => {
    if (
      authedViewersModalOpen &&
      authedViewersModalPage !== authedModalPageSafe
    )
      setAuthedViewersModalPage(authedModalPageSafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedViewersModalOpen, authedModalPageSafe]);
  useEffect(() => {
    if (anonViewersModalOpen && anonViewersModalPage !== anonModalPageSafe)
      setAnonViewersModalPage(anonModalPageSafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anonViewersModalOpen, anonModalPageSafe]);

  /**
   * The trail's first step: "Project" or "Document", the hierarchy word.
   *
   * It waits for the name. While the title beside it was a skeleton this crumb was the only text in
   * the band, sitting top-left where the name goes — so the page appeared to be titled "Project" and
   * then to rename itself when the real name arrived. That is the bug, exactly as reported.
   */
  const parentCrumb = (
    <EntityCrumbLabel
      kind={scope.kind === "project" ? "project" : "doc"}
      id={scope.id}
      noun={noun}
      name={resourceTitle}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {/* A sub-page keeps its resource's own header band — same gutter, same height, same title
          line — with the breadcrumb where that page puts its description or its file facts, so
          walking from a project or a document into its metrics moves nothing and still feels like
          being inside the thing you opened. The way back is the breadcrumb's first crumb, sitting
          where the parent page's own icon does, which is why there is no back arrow in front of
          the tile pushing the title off that line.

          One link's metrics sit under the links list, not under the document: the breadcrumb says
          so when `?shareId=` is set. Hierarchical rather than referrer-based on purpose — the same
          URL is reached from the activity feed and the side panel, and the parent of a link is the
          list either way. */}
      <SubPageHeader
        kind={shareId ? "link" : scope.kind === "project" ? "project" : "doc"}
        parent={scope.kind === "project" ? "project" : "doc"}
        // A document's own metrics page leads with the document's title row, so walking in from
        // the header icons feels like going deeper rather than leaving. One link's metrics keep
        // the link tile: there, the thing you are inside is the link.
        hideTile={!shareId}
        title={
          shareId ? (
            // A link's metrics is titled with the resource the link points at. Same rule as the
            // identity rows: the name, or a skeleton — never the bare noun, which under a
            // `?shareId=` filter used to stand here for as long as the whole aggregation took.
            <EntityHeaderName
              kind={scope.kind === "project" ? "project" : "doc"}
              id={scope.id}
              name={resourceTitle}
            />
          ) : scope.kind === "doc" ? (
            <DocIdentityRow
              docId={scope.id}
              fallbackTitle={resourceTitle || remembered || ""}
            />
          ) : (
            <ProjectIdentityRow
              projectId={scope.id}
              name={resourceTitle || remembered || ""}
            />
          )
        }
        titleHref={shareId ? basePath : undefined}
        crumbs={
          shareId
            ? [
                { label: parentCrumb, href: basePath },
                { label: "Links", href: `${basePath}/links` },
                // A breadcrumb is a name slot: "this link" is a phrase for a sentence, not a label.
                { label: selectedLinkSlot },
              ]
            : [{ label: parentCrumb, href: basePath }, { label: "Metrics" }]
        }
        actions={
          // The parent page's own cluster, from the same component it renders, so the controls
          // never move between a resource and its sub-pages.
          scope.kind === "project" ? (
            <ProjectHeaderActions
              projectSlug={scope.id}
              current={shareId ? "links" : "metrics"}
            />
          ) : (
            // "Replace file" first, then the cluster — the order the document page uses, so the
            // whole right-hand group is the same shape wherever you are inside the document.
            <div className="flex items-center gap-2 md:gap-3">
              <DocReplaceFileButton docId={scope.id} />
              <DocHeaderActions docId={scope.id} current={shareId ? "links" : "metrics"} />
            </div>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        {/* The body lines up with the header band above it. */}
        <div className={`w-full py-6 ${APP_PAGE_GUTTER}`}>
          <div className="mt-1 grid gap-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {/* The scope belongs in the heading, not only in a chip row that scrolls away:
                    a reader who lands further down the page was otherwise reading one link's
                    numbers under a heading that said "Metrics" and section titles that said
                    "this document". */}
                {/* A link's page is named by the address the recipient was actually sent, at the size
                    of a title: that URL is the thing being measured, and a private label ("Default
                    link") is not what anyone pasted into an email. The document and project views
                    keep "Metrics" as their heading, with the link count as the pill that says this
                    is every link rather than one. */}
                {shareId && publicUrl ? (
                  <>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">
                      {scope.kind === "project"
                        ? "Project link"
                        : "Document link"}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <a
                        href={publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${publicUrl}`}
                        className="group inline-flex min-w-0 items-center gap-2 text-[var(--fg)]"
                      >
                        <LinkIcon
                          className="h-[18px] w-[18px] shrink-0 text-[var(--muted-2)] group-hover:text-[var(--fg)]"
                          aria-hidden="true"
                        />
                        <span className="truncate font-mono text-[18px] font-semibold tracking-tight sm:text-[20px] group-hover:underline underline-offset-4">
                          {publicUrl.replace(/^https?:\/\//, "")}
                        </span>
                      </a>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg p-1.5 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                        aria-label={urlCopied ? "Link copied" : "Copy link"}
                        title={urlCopied ? "Copied" : "Copy link"}
                        onClick={() => {
                          void (async () => {
                            try {
                              await navigator.clipboard.writeText(publicUrl);
                              setUrlCopied(true);
                              window.setTimeout(
                                () => setUrlCopied(false),
                                1600,
                              );
                            } catch {
                              // Clipboard can be refused (permissions, insecure origin); the address
                              // is still selectable in the anchor above.
                            }
                          })();
                        }}
                      >
                        {urlCopied ? (
                          <ClipboardDocumentCheckIcon className="h-4 w-4" />
                        ) : (
                          <Square2StackIcon className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--muted)]">
                      <span className="max-w-[280px] truncate font-medium text-[var(--fg)]">
                        {selectedLinkSlot}
                      </span>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        onClick={() => selectLink(null)}
                        className="font-medium text-[var(--muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold text-[var(--fg)]">
                    <span>Metrics</span>
                    {typeof data?.linksTotal === "number" &&
                    data.linksTotal > 1 ? (
                      // A pill, not a trailing clause: this is the top-level, every-link view, and
                      // the count is the one fact that says so at a glance.
                      <span className="inline-flex items-center rounded-full bg-[var(--panel-hover)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--fg)] ring-1 ring-inset ring-[var(--border)]">
                        All {data.linksTotal} links
                      </span>
                    ) : null}
                  </div>
                )}
                {selectedLinkLabel && data?.link ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--muted)]">
                    {data.link.audience ? (
                      <SettingItem
                        label="Audience"
                        value={data.link.audience}
                      />
                    ) : null}
                    {/* On a project link "Download on" could be read as "download the whole room";
                        there is no bulk download, so say what it actually permits. */}
                    <SettingItem
                      label="Download"
                      value={
                        data.link.allowDownload
                          ? scope.kind === "project"
                            ? "each document"
                            : "on"
                          : "off"
                      }
                    />
                    <SettingItem
                      label="Password"
                      value={data.link.passwordEnabled ? "set" : "none"}
                    />
                    {scope.showRevisionHistory ? (
                      <SettingItem
                        label="Version history"
                        value={data.link.allowRevisionHistory ? "on" : "off"}
                      />
                    ) : null}
                    <SettingItem
                      label="Expires"
                      value={
                        data.link.expiresAt
                          ? formatDateShort(data.link.expiresAt)
                          : "Never"
                      }
                    />
                    {typeof data.linksTotal === "number" &&
                    data.linksTotal > 1 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link
                          href={`${basePath}/links`}
                          className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                        >
                          Part of {data.linksTotal} links
                        </Link>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-1 text-sm text-[var(--muted)]">
                  {dateRangeLabel}
                </div>
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
                              active
                                ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                                : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
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
                <span>
                  That link was deleted. Showing all links, so every number
                  below is the whole {scope.nounLower} now.
                </span>
                <button
                  type="button"
                  onClick={() => setFilterDroppedNotice(false)}
                  className="shrink-0 font-medium text-[var(--muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {error && data ? (
              <div
                role="status"
                className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5 text-[13px] text-[var(--muted)]"
              >
                Could not refresh these numbers. Showing the last ones that loaded.
              </div>
            ) : null}

            {/* Who opened it, newest first — above the tiles, because "did they read it yet" is the
                question this page is opened to answer and it used to be several screens down.

                Held back until the identities land. This page makes two requests: a light one that
                carries project-link readers, and a second that carries everyone else. Rendering on
                the first meant the card painted one list — twelve project readers — and then
                repainted a different one a moment later when the other twenty arrived, re-sorted by
                recency. That is the flicker; the fix is to draw it once, when what it says is
                settled. On Free there is no second request and nothing to wait for. */}
            {deepAnalytics && !viewersLoaded && !viewersEverLoadedRef.current ? null : (
              <RecentVisitors
                visitors={recentVisitors}
                className="mb-5"
                onSeeAll={() => {
                  document
                    .getElementById("viewer-lists")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              {/* Views card */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">
                    VIEWS
                  </div>

                  {loading ? (
                    <div
                      className="mt-1 h-9 w-16 animate-pulse rounded bg-[var(--panel-hover)]"
                      aria-hidden="true"
                    />
                  ) : error && !data ? (
                    <div className="mt-1 text-sm text-red-700">{error}</div>
                  ) : (
                    <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">
                      {views}
                    </div>
                  )}

                  <div className="mt-2 text-sm text-[var(--muted)]">
                    {loading ? (
                      <div
                        className="h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]"
                        aria-hidden="true"
                      />
                    ) : (
                      <>
                        {/* Opens first: it is the fact the big number above cannot carry. That
                            number counts recipients, so a reader who came back every morning for a
                            week is one view — the returns only show up here. */}
                        {opens !== null ? (
                          <>
                            <span className="tabular-nums">{opens}</span> open
                            {opens === 1 ? "" : "s"}
                            {opens > views ? (
                              <span className="text-[var(--muted-2)]">
                                {" "}
                                ({(opens - views).toLocaleString()} return
                                {opens - views === 1 ? "" : "s"})
                              </span>
                            ) : null}{" "}
                            ·{" "}
                          </>
                        ) : null}
                        <span className="tabular-nums">{pagesViewed}</span>{" "}
                        {supportsPageDetail
                          ? "pages viewed"
                          : `document${pagesViewed === 1 ? "" : "s"} opened`}{" "}
                        ·{" "}
                        {/* Project-only, and the fact that makes a data room different from a
                            deck: someone can open the link, read the file list and leave. The big
                            number above cannot show them — they wrote no `ShareView` row at all —
                            so without this clause they are invisible on a page that claims to
                            cover the project. Omitted entirely at zero: a clause that is usually
                            absent reads as news when it appears, where a permanent "0 landed
                            without opening a document" reads as furniture. */}
                        {landedWithoutOpening ? (
                          <>
                            <span className="tabular-nums">
                              {landedWithoutOpening}
                            </span>{" "}
                            landed without opening a document ·{" "}
                          </>
                        ) : null}
                        {analyticsTier === null ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="h-3 w-12 rounded bg-[var(--panel-hover)] motion-safe:animate-pulse"
                              aria-hidden="true"
                            />
                            <span>viewers</span>
                          </span>
                        ) : !deepAnalytics ? (
                          <>
                            <span className="tabular-nums">{viewerCount}</span>{" "}
                            {viewerCount === 1 ? "person" : "people"}
                          </>
                        ) : viewersLoading ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="h-3 w-12 animate-pulse rounded bg-[var(--panel-hover)]"
                              aria-hidden="true"
                            />
                            <span>authenticated viewers</span>
                          </span>
                        ) : viewersLoaded ? (
                          <>
                            <span className="tabular-nums">
                              {authedViewers}
                            </span>{" "}
                            authenticated viewers
                            {typeof data?.totals?.anonymousViewers ===
                            "number" ? (
                              <>
                                {" "}
                                ·{" "}
                                <span className="tabular-nums">
                                  {anonViewers}
                                </span>{" "}
                                anonymous viewers
                              </>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <span className="tabular-nums">–</span>{" "}
                            authenticated viewers
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {/* The big number above counts this document's own links only. When the document
                      also sits in a data room, saying so here is the difference between a reader
                      trusting the number and thinking views went missing. */}
                  {!loading && projectLinkTraffic ? (
                    <div className="mt-1 text-sm text-[var(--muted)]">
                      <span className="tabular-nums">
                        +{projectLinkTraffic.views.toLocaleString()}
                      </span>{" "}
                      view
                      {projectLinkTraffic.views === 1 ? "" : "s"} came through
                      project links, counted with the project
                    </div>
                  ) : null}

                  {/* Your own opens, said out loud.
                      They are recorded and deliberately never counted — "4 views · 1 person" on a
                      deck no investor has opened is worse than no number — but silence about them
                      has its own failure: open your own link to check it, watch nothing move, and
                      the page reads as broken rather than as correct. The exclusion is the feature;
                      this is the receipt. */}
                  {!loading && (data?.totals?.ownerPreviews ?? 0) > 0 ? (
                    <div className="mt-1 text-sm text-[var(--muted-2)]">
                      <span className="tabular-nums">
                        {(data?.totals?.ownerPreviews ?? 0).toLocaleString()}
                      </span>{" "}
                      {(data?.totals?.ownerPreviews ?? 0) === 1
                        ? "open"
                        : "opens"}{" "}
                      by you, not counted
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Downloads card */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">
                    DOWNLOADS
                  </div>

                  {loading ? (
                    <div
                      className="mt-1 h-9 w-20 animate-pulse rounded bg-[var(--panel-hover)]"
                      aria-hidden="true"
                    />
                  ) : error && !data ? (
                    <div className="mt-1 text-sm text-red-700">{error}</div>
                  ) : downloadsKnown ? (
                    // Real downloads stay visible after downloads are turned off: they happened.
                    <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">
                      {downloads}
                    </div>
                  ) : (
                    <div
                      className="mt-1 h-9 w-20 animate-pulse rounded bg-[var(--panel-hover)]"
                      aria-hidden="true"
                    />
                  )}

                  <div className="mt-2 text-sm text-[var(--muted)]">
                    {loading ? (
                      <div
                        className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]"
                        aria-hidden="true"
                      />
                    ) : downloadsEnabled ? (
                      <span className="text-[var(--muted)]">PDF downloads</span>
                    ) : downloadsKnown && downloads > 0 ? (
                      <span className="text-[var(--muted)]">
                        {selectedLinkLabel
                          ? `Downloads are now off for ${selectedLinkLabel}.`
                          : "Downloads are now off on every link."}
                      </span>
                    ) : (
                      // "this share link" named one link on a surface that aggregates all of them,
                      // so the reader could not tell what the sentence was about.
                      <span className="text-[var(--muted)]">
                        {selectedLinkLabel
                          ? `PDF download is off for ${selectedLinkLabel}.`
                          : `No link of this ${nounLower} allows PDF download.`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Two separate charts (Views + Downloads) */}
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="text-sm font-semibold text-[var(--fg)]">
                  Views
                </div>
                <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
                  {loading ? (
                    <div
                      className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <MiniLineChartSingle
                      series={chartSeries}
                      values={viewsSeries}
                      stroke="var(--chart-views)"
                      fillId="lnkdrpMetricsPageFillViews"
                      fillStops={{ topOpacity: 0.22, bottomOpacity: 0 }}
                    />
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--fg)]">
                    Downloads
                  </div>
                  {!loading && !downloadsEnabled ? (
                    <div className="text-xs font-medium text-[var(--muted)]">
                      Downloads off
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
                  {loading ? (
                    <div
                      className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <MiniLineChartSingle
                      series={chartSeries}
                      values={downloadsSeries}
                      stroke="var(--chart-downloads)"
                      fillId="lnkdrpMetricsPageFillDownloads"
                      fillStops={{ topOpacity: 0.18, bottomOpacity: 0 }}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Where the reads came from, under the chart they are missing from.
                A document inside a project is opened through the project's link, and those reads
                belong to the project (docScope.ts) — so the document's own numbers exclude them,
                and this says what the other number is and which project carried it.

                "Projects" is the product's word for these. A workspace may call one of them a data
                room; that is its name for one project, not a rename of the feature. */}
            {!loading &&
            projectLinkTraffic &&
            projectLinkTraffic.links.length ? (
              <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">
                    Opened through projects
                  </div>
                  <div className="text-[12px] text-[var(--muted-2)]">
                    Counted with the project, not with this document
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
                    {projectLinkTraffic.views.toLocaleString()}
                  </span>
                  <span className="text-[13px] text-[var(--muted)]">
                    {projectLinkTraffic.views === 1 ? "view" : "views"}
                    {projectLinkTraffic.viewers > 0
                      ? ` · ${projectLinkTraffic.viewers.toLocaleString()} ${projectLinkTraffic.viewers === 1 ? "viewer" : "viewers"}`
                      : ""}
                  </span>
                </div>
                <ul className="mt-3 grid gap-1.5 border-t border-[var(--divider)] pt-3">
                  {projectLinkTraffic.links.slice(0, 5).map((l) => (
                    <li key={l.shareId} className="flex items-center gap-3">
                      <FolderIcon
                        className="h-4 w-4 shrink-0 text-[var(--muted-2)]"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]">
                        {l.projectId ? (
                          <Link
                            href={`/project/${encodeURIComponent(l.projectId)}/metrics`}
                            className="hover:underline underline-offset-4"
                          >
                            {l.projectName || "Project"}
                          </Link>
                        ) : (
                          l.projectName || "Project"
                        )}
                        {l.label ? (
                          <span className="text-[var(--muted-2)]">
                            {" "}
                            · {l.label}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[12px] tabular-nums text-[var(--muted)]">
                        {l.views.toLocaleString()}{" "}
                        {l.views === 1 ? "view" : "views"}
                      </span>
                      <span className="w-20 shrink-0 text-right text-[12px] text-[var(--muted-2)]">
                        {l.lastViewedAt ? relativeAge(l.lastViewedAt) : "–"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* The card that makes this the *master* metrics page rather than a wider version of
                a single link's: how many links this document has, which ones are pulling the
                traffic, and which are live right now. Master mode only — under a single-link
                filter this would be ranking the very link the page is about against the others,
                a different question than the one the reader is asking. Ranked and bounded to a
                handful of rows (`topLinksByViewers`/`recentlyOpenedLinks`, from the server's
                already-bounded `byLink`), never every link — see `LinksManager` for that. */}
            {!selectedLinkLabel &&
            data &&
            typeof data.linksTotal === "number" &&
            data.linksTotal > 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">
                      LINKS
                    </div>
                    <div className="mt-1 text-3xl font-semibold tabular-nums text-[var(--fg)]">
                      {data.linksTotal}
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {data.linksTotal === 1
                        ? "One link, shown above"
                        : "Every number above is the sum across all of them"}
                    </div>
                  </div>
                  <Link
                    href={`${basePath}/links`}
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
                                  href={`${basePath}/metrics?shareId=${encodeURIComponent(r.shareId)}`}
                                  className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                                >
                                  {r.label}
                                </Link>
                              ) : (
                                <span
                                  className="min-w-0 truncate text-[var(--muted)]"
                                  title="This link was deleted; its traffic is still counted above"
                                >
                                  Deleted link
                                </span>
                              )}
                              <span className="shrink-0 tabular-nums text-[var(--muted)]">
                                {r.viewers.toLocaleString()} viewer
                                {r.viewers === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]">
                              <div
                                className="h-full rounded-full bg-[var(--chart-views)]"
                                style={{
                                  width: `${Math.max(4, (r.viewers / maxTopLinkViewers) * 100)}%`,
                                }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Recently opened
                      </div>
                      <ul className="mt-1.5 space-y-1.5">
                        {recentlyOpenedLinks.map((r) => (
                          <li
                            key={r.shareId}
                            className="flex items-baseline justify-between gap-3 text-[13px]"
                          >
                            {r.label ? (
                              <Link
                                href={`${basePath}/metrics?shareId=${encodeURIComponent(r.shareId)}`}
                                className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                              >
                                {r.label}
                              </Link>
                            ) : (
                              <span
                                className="min-w-0 truncate text-[var(--muted)]"
                                title="This link was deleted; its traffic is still counted above"
                              >
                                Deleted link
                              </span>
                            )}
                            <span className="shrink-0 whitespace-nowrap text-[var(--muted)]">
                              {relativeAge(r.lastViewedAt)}
                            </span>
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
                      {data.deletedLinkResidual.count === 1
                        ? "1 deleted link"
                        : `${data.deletedLinkResidual.count} deleted links`}
                    </span>{" "}
                    still carr
                    {data.deletedLinkResidual.count === 1 ? "ies" : "y"}{" "}
                    {data.deletedLinkResidual.viewers.toLocaleString()} viewer
                    {data.deletedLinkResidual.viewers === 1 ? "" : "s"} in the
                    totals above.
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Readings that came in through a project link.

                A document in a data room is opened through the *project's* slug, not its own, so
                those rows carry no `docId`-owned link and are excluded from every figure above —
                deliberately, so this page, the workspace rollup and `Doc.numberOfViews` keep
                agreeing. The cost of that decision is that an owner could see "Michael J read
                USAVX Deck" in the activity feed and then find nobody on the document's own metrics
                page. This card is where those readings are reported: their own numbers, their own
                heading, never folded into the tiles.

                Identity follows the same gate as the rest of the page — on Basic the server never
                sends names, so the counts and the "via <project>" grouping are all this shows. */}

            {/* The project's second ranking, directly under LINKS and built to the same pattern:
                a document's story is told by page, a project's by *document*. "Which file did they
                open first" is what a data room's owner is actually asking, and it is the one
                question neither the tiles nor the per-link card can answer.

                Unlike LINKS this card survives a `?shareId=` filter — scoped to that link it
                answers "what did this recipient group go and read", which is precisely the point
                of looking at one link. */}
            {isProject && data && typeof data.docsTotal === "number" ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">
                      DOCUMENTS
                    </div>
                    <div className="mt-1 text-3xl font-semibold tabular-nums text-[var(--fg)]">
                      {data.docsTotal}
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {/* `pagesViewed` (= `totals.docsOpened`) counts distinct documents in the
                          analytics rows, which include documents since removed from the project or
                          un-shared — so it can exceed `docsTotal`, and an unclamped comparison
                          claimed "every one of them opened" for a project whose only remaining
                          document had never been touched. Clamped, the sentence can only ever
                          overstate downward. */}
                      {data.docsTotal === 0
                        ? "No documents shared in this project yet."
                        : pagesViewed === 0
                          ? `None opened in the last ${days} days`
                          : Math.min(pagesViewed, data.docsTotal) >=
                              data.docsTotal
                            ? `Every one of them opened in the last ${days} days`
                            : `${Math.min(pagesViewed, data.docsTotal)} of them opened in the last ${days} days`}
                    </div>
                  </div>
                  <Link
                    href={basePath}
                    className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                  >
                    All documents
                  </Link>
                </div>

                {topDocsByViewers.length || recentlyOpenedDocs.length ? (
                  <div className="mt-4 grid gap-x-6 gap-y-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Top documents · by readers
                      </div>
                      {/* Same emerald bars, scaled to the longest bar in this list, as the links
                          above — the two lists answer the same shape of question and a reader who
                          has learned to read one must not have to learn the other. */}
                      <ul className="mt-2 space-y-2">
                        {topDocsByViewers.map((r) => (
                          <li key={r.docId} className="text-[13px]">
                            <div className="flex items-baseline justify-between gap-3">
                              {r.title ? (
                                /* The document, not its metrics page. Under the locked rule a
                                   data-room read is the project's and is excluded from the
                                   document's own figures, so `/doc/:id/metrics` is defined not to
                                   contain the reading this row is made of: the one-pager listed
                                   here as "opened by 2" opened a page reading "nobody has ever
                                   opened this". The reading lives on this page; the link is for
                                   going to the file. */
                                <Link
                                  href={`/doc/${encodeURIComponent(r.docId)}`}
                                  className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                                >
                                  {r.title}
                                </Link>
                              ) : (
                                <span
                                  className="min-w-0 truncate text-[var(--muted)]"
                                  title="This document was deleted; its traffic is still counted above"
                                >
                                  Deleted document
                                </span>
                              )}
                              {/* "opened by 4", not "4 viewers": these rows count (document,
                                  viewer) buckets while the LINKS card counts (link, viewer) ones,
                                  so one person who opened two files is in two rows here and one
                                  row there. Printing the same word over two different units left
                                  two adjacent cards that did not add up to the same tile. */}
                              <span className="shrink-0 tabular-nums text-[var(--muted)]">
                                opened by {r.viewers.toLocaleString()}
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]">
                              <div
                                className="h-full rounded-full bg-[var(--chart-views)]"
                                style={{
                                  width: `${Math.max(4, (r.viewers / maxTopDocViewers) * 100)}%`,
                                }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Recently opened
                      </div>
                      <ul className="mt-1.5 space-y-1.5">
                        {recentlyOpenedDocs.map((r) => (
                          <li
                            key={r.docId}
                            className="flex items-baseline justify-between gap-3 text-[13px]"
                          >
                            {r.title ? (
                              /* `/doc/:id`, not `/doc/:id/metrics` — same reason as the ranking
                                 above: the document's own metrics page excludes every read made
                                 through this project's links. */
                              <Link
                                href={`/doc/${encodeURIComponent(r.docId)}`}
                                className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                              >
                                {r.title}
                              </Link>
                            ) : (
                              <span
                                className="min-w-0 truncate text-[var(--muted)]"
                                title="This document was deleted; its traffic is still counted above"
                              >
                                Deleted document
                              </span>
                            )}
                            <span className="shrink-0 whitespace-nowrap text-[var(--muted)]">
                              {relativeAge(r.lastViewedAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}

                {/* The DOCUMENTS twin of the LINKS card's deleted-link footnote, and there for the
                    same reason: a reader adds a column up and expects the tile above it. These
                    rows do not, and the one sentence that explains why belongs beside them. */}
                {topDocsByViewers.length || recentlyOpenedDocs.length ? (
                  <div className="mt-3 border-t border-[var(--border)] pt-3 text-[12px] text-[var(--muted)]">
                    {topDocsByViewers.length > 1 ? (
                      <>
                        Someone who opened two documents appears in both rows,
                        so these add up to more than the{" "}
                        <span className="font-medium text-[var(--fg)]">
                          Views
                        </span>{" "}
                        above.{" "}
                      </>
                    ) : null}
                    {/* Says out loud what the hrefs above now assume: this reading is counted here
                        and nowhere else, so a document whose only traffic came through this project
                        shows zero on its own metrics page. Without the sentence that page reads as
                        a contradiction rather than a different scope. */}
                    These reads are counted on this project. A document&rsquo;s
                    own page counts only its own links.
                  </div>
                ) : null}
              </div>
            ) : null}

            {!deepAnalytics ? (
              <LockedViewersBlock
                pending={analyticsTier === null}
                loading={loading || !hasData}
                count={viewerCount}
                days={days}
                teaser={data?.teaser ?? null}
                linkLabel={selectedLinkLabel}
                nounLower={nounLower}
                onUpgrade={() => openUpgrade("analytics_history")}
              />
            ) : (
              <>
                {/* One list, not three.
                    Signed-in, anonymous and project readers were three headings with three
                    explanations, which made the reader do the merging — and left "who read this?"
                    answered differently depending on which section you happened to be looking at.
                    They are one list now, newest first, and what distinguishes them travels on the
                    row: the depth badge, the project chip, and whether a name is known. */}
                <div className="mt-1" id="viewer-lists">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--fg)]">
                    Viewers
                    <ReadingLegendButton />
                  </div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    Everyone who opened it, newest first.
                  </div>

                  <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                    {loading ? (
                      <div className="p-4">
                        <div
                          className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]"
                          aria-hidden="true"
                        />
                        <div
                          className="mt-3 h-4 w-72 animate-pulse rounded bg-[var(--panel-hover)]"
                          aria-hidden="true"
                        />
                        <div
                          className="mt-3 h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]"
                          aria-hidden="true"
                        />
                      </div>
                    ) : error && !data ? (
                      <div className="p-4 text-sm text-red-700">{error}</div>
                    ) : viewersLoading && !allViewerRows.length ? (
                      <div className="p-4 text-sm text-[var(--muted)]">
                        Loading viewers…
                      </div>
                    ) : !allViewerRows.length ? (
                      <div className="p-4 text-sm text-[var(--muted)]">
                        No viewers yet.
                      </div>
                    ) : (
                      <ul className="divide-y divide-[var(--border)]">
                        {allViewerRows.slice(0, VIEWERS_SHOWN).map((row) => {
                          const body = (
                            <>
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <UserIcon
                                    className="h-5 w-5 shrink-0 text-[var(--muted-2)]"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate text-sm font-semibold text-[var(--fg)]">
                                    {row.title}
                                  </span>
                                  <DepthBadge
                                    timeMs={row.timeMs}
                                    pages={row.pages}
                                    totalPages={docTotalPages}
                                  />
                                  {row.vias.map((via) => (
                                    <span
                                      key={via.name}
                                      className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]"
                                    >
                                      <FolderIcon
                                        className="h-3 w-3 shrink-0"
                                        aria-hidden="true"
                                      />
                                      <span className="truncate">
                                        {via.name}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                                {row.subtitle ? (
                                  <div className="mt-0.5 truncate pl-7 text-xs text-[var(--muted-2)]">
                                    {row.subtitle}
                                  </div>
                                ) : null}
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-xs font-medium tabular-nums text-[var(--muted-2)]">
                                  {row.stats}
                                </div>
                                <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                                  {row.lastSeen
                                    ? relativeAge(row.lastSeen)
                                    : "–"}
                                </div>
                              </div>
                            </>
                          );
                          const rowClass =
                            "flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--panel-hover)]";
                          return (
                            <li key={row.key}>
                              {row.href ? (
                                <Link
                                  href={row.href}
                                  className={rowClass}
                                  title={row.hint}
                                >
                                  {body}
                                </Link>
                              ) : (
                                <div className={rowClass}>{body}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {allViewerRows.length > VIEWERS_SHOWN ? (
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setAuthedViewersModalPage(0);
                          setAuthedViewersModalOpen(true);
                        }}
                      >
                        See all {allViewerRows.length}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* The same list, all of it. One modal now, because there is one list. */}
      <Modal
        open={authedViewersModalOpen}
        onClose={() => setAuthedViewersModalOpen(false)}
        ariaLabel="Viewers"
      >
        <div className="text-base font-semibold text-[var(--fg)]">Viewers</div>
        <div className="mt-1 text-sm text-[var(--muted)]">
          Everyone who opened it, newest first.
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
          {!allViewerRows.length ? (
            <div className="p-4 text-sm text-[var(--muted)]">
              No viewers yet.
            </div>
          ) : (
            <ul className="max-h-[min(60vh,560px)] divide-y divide-[var(--border)] overflow-auto">
              {allViewerRows.map((row) => {
                const body = (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <UserIcon
                          className="h-5 w-5 shrink-0 text-[var(--muted-2)]"
                          aria-hidden="true"
                        />
                        <span className="truncate text-sm font-semibold text-[var(--fg)]">
                          {row.title}
                        </span>
                        <DepthBadge
                          timeMs={row.timeMs}
                          pages={row.pages}
                          totalPages={docTotalPages}
                        />
                        {row.vias.map((via) => (
                          <span
                            key={via.name}
                            className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]"
                          >
                            <FolderIcon
                              className="h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">{via.name}</span>
                          </span>
                        ))}
                      </div>
                      {row.subtitle ? (
                        <div className="mt-0.5 truncate pl-7 text-xs text-[var(--muted-2)]">
                          {row.subtitle}
                        </div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-medium tabular-nums text-[var(--muted-2)]">
                        {row.stats}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                        {row.lastSeen ? relativeAge(row.lastSeen) : "–"}
                      </div>
                    </div>
                  </>
                );
                const rowClass =
                  "flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--panel-hover)]";
                return (
                  <li key={row.key}>
                    {row.href ? (
                      <Link
                        href={row.href}
                        className={rowClass}
                        title={row.hint}
                        onClick={() => setAuthedViewersModalOpen(false)}
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className={rowClass}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}
