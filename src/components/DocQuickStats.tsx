"use client";

import Link from "next/link";
import { ChartBarIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { subscribeRealtime } from "@/lib/client/realtime";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { usePlan } from "@/lib/client/usePlan";
import { formatDayKey } from "@/lib/format/date";
import { valueLabels } from "@/components/charts/ChartValueLabel";

/**
 * Quick engagement stats for the owner's document page side panel.
 *
 * Renders instantly from the denormalized `Doc.metricsSnapshot` (rolled up by the doc-metrics
 * cron), then refreshes from `/api/docs/:docId/shareviews?lite=1` for live totals and the
 * people-by-day series that feeds the chart. Single series, so no legend; the title names it.
 *
 * Free workspaces get the basic tier: the People tile still shows how many people opened the
 * document (`viewerCount`) with a small "see who · Pro" link, and the footer names the 7-day
 * window; both open the `analytics_history` upsell.
 */

/**
 * The one field this component still needs straight from `GET /api/docs/:docId/links`: the label
 * of a document's *sole* link, for the one-link header line. Everything else — the ranking, the
 * labels of the links in that ranking — comes bounded from the analytics response's `byLink` now,
 * so this is fetched with `?limit=1`: enough to read `total` and (when there is exactly one link)
 * that link's label, never enough to render a list.
 */
type LinkSummary = { id: string; label: string; shareId: string };

type Snapshot = {
  updatedAt: string | null;
  days: number | null;
  lastDaysViews: number;
  lastDaysDownloads: number;
  downloadsTotal: number;
} | null;

type StatsResponse = {
  ok?: boolean;
  days?: number;
  /** Present when the workspace plan clamps the analytics window (Free = 7 days). */
  analyticsDaysLimit?: number;
  /** Which tier the server rendered; `"basic"` on Free (no identities, per-page maps omitted). */
  analyticsTier?: "basic" | "deep";
  /** Unique viewers (signed-in + anonymous) in the window. */
  viewerCount?: number;
  totals?: {
    downloads?: number;
    /** Lifetime time of viewers active in the window; only a fallback for servers without `visitTimeMs`. */
    timeSpentMs?: number;
    /** Time spent in visits active in the window (ms). */
    visitTimeMs?: number;
    authenticatedViewers?: number;
    anonymousViewers?: number;
  };
  /** Most recent recorded activity in scope, all time. */
  lastViewedAt?: string | null;
  series?: Array<{ date: string; views: number; opens?: number; downloads: number }>;
  /** Whether downloads are allowed on any live link of the document (a label, not a filter). */
  downloadsEnabled?: boolean;
  /**
   * `?byLink=1&topLinks=N`: a bounded ranking, not the whole per-link table — at most the top `N`
   * by views and the top `N` by recency, deduped, with `label`/`isDefault` attached so this card
   * never has to fetch every link of the document just to name the handful it shows. Capped at a
   * fixed size regardless of how many links the document actually has.
   */
  byLink?: Array<{
    shareId: string;
    views: number;
    viewers: number;
    opens?: number;
    downloads: number;
    lastViewedAt?: string | null;
    label?: string | null;
    isDefault?: boolean;
  }>;
  /** Count of live links, alongside a `byLink` that may only cover a few of them. */
  linksTotal?: number;
};

const DAYS = 15;
/** How many links `topLinks` asks the server to rank by each of the two criteria (views, recency);
 * the card only ever shows 3 of each, but a link that is #2 by views and #1 by recency needs room
 * in the merged set to appear in both lists. */
const TOP_LINKS_LIMIT = 5;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/** Compact reading time for a tile: "0s", "45s", "12m", "3h 20m". */
function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}


function relativeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One row of `LinkMiniList`. */
type LinkMiniRow = { shareId: string; label: string | null; viewers: number; views: number; lastViewedAt: string | null };

/**
 * A three-row ranking of links, each row opening the metrics page already filtered to that link.
 *
 * The label is the target, not a separate "view" affordance: the name of a link is what a reader
 * reaches for when they want to know more about it, and the card has no room for a second control
 * per row.
 */
function LinkMiniList({
  title,
  docId,
  rows,
  empty,
  right,
}: {
  title: string;
  docId: string;
  rows: LinkMiniRow[];
  empty: string;
  right: (row: LinkMiniRow) => React.ReactNode;
}) {
  return (
    <div data-linklist className="min-w-0">
      {/* Fixed one-line height, so side-by-side lists start their first rows on the same line. */}
      <div
        data-linklist-title
        className="h-[14px] truncate whitespace-nowrap text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-[var(--muted-2)]"
        title={title}
      >
        {title}
      </div>
      {rows.length ? (
        <ul className="mt-1 space-y-1">
          {rows.map((r) => (
            <li key={r.shareId} className="flex items-baseline justify-between gap-3 text-[11px]">
              {r.label ? (
                <Link
                  href={`/doc/${encodeURIComponent(docId)}/metrics?shareId=${encodeURIComponent(r.shareId)}`}
                  className="min-w-0 truncate font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                  title={`${r.label} — see who opened it`}
                >
                  {r.label}
                </Link>
              ) : (
                <span className="min-w-0 truncate text-[var(--muted)]" title="This link was deleted; its traffic is still counted above">
                  Deleted link
                </span>
              )}
              <span className="shrink-0 text-[var(--muted)]">{right(r)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-[11px] text-[var(--muted-2)]">{empty}</div>
      )}
    </div>
  );
}

/**
 * A smooth area over the daily counts, with each day that has any labelled by its number, so the
 * shape reads at a glance and the values don't need a hover. The date axis is drawn by the chart
 * so the first, middle and last labels sit under their points.
 */
function DailyArea({ data, unit }: { data: Array<{ date: string; value: number }>; unit: [singular: string, plural: string] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w > 0 && h > 0) setSize({ w, h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ticks = data.length ? [...new Set([data[0].date, data[Math.floor((data.length - 1) / 2)].date, data[data.length - 1].date])] : [];

  return (
    <div ref={wrapRef} className="h-28 w-full">
      {size ? (
        <AreaChart width={size.w} height={size.h} data={data} margin={{ top: 18, right: 4, bottom: 3, left: 4 }}>
          <defs>
            <linearGradient id="lnkdrpQuickStatsViews" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-views)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--chart-views)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, "dataMax"]} />
          <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
          <XAxis
            dataKey="date"
            ticks={ticks}
            interval={0}
            tickLine={false}
            axisLine={false}
            height={22}
            // First and last labels anchor to their outer edge; centred on the edge points they
            // were clipped by the card ("ep 10", "Sep 1").
            tick={(props: { x: number; y: number; payload: { value: string } }) => {
              const i = ticks.indexOf(props.payload.value);
              const anchor = i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle";
              return (
                <text x={props.x} y={props.y + 12} textAnchor={anchor} fontSize={10} fill="var(--muted-2)">
                  {formatDayKey(props.payload.value)}
                </text>
              );
            }}
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
            formatter={(v: unknown) => [typeof v === "number" ? `${v.toLocaleString()} ${v === 1 ? unit[0] : unit[1]}` : String(v), ""]}
            labelFormatter={(label: unknown) => formatDayKey(String(label ?? ""))}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--chart-views)"
            strokeWidth={1.5}
            fill="url(#lnkdrpQuickStatsViews)"
            fillOpacity={1}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 1.5 }}
            isAnimationActive={false}
          >
            <LabelList dataKey="value" content={valueLabels({ values: data.map((d) => d.value) })} />
          </Area>
        </AreaChart>
      ) : null}
    </div>
  );
}

/** Quick stats card for the owner doc page: up to four tiles, link lists, a people-by-day chart and the metrics link. */
export default function DocQuickStats({
  docId,
  snapshot,
  downloadsEnabled,
}: {
  docId: string;
  snapshot: Snapshot;
  downloadsEnabled: boolean;
}) {
  const [live, setLive] = useState<StatsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const { openUpgrade } = useUpgradeModal();
  const { plan } = usePlan();
  // The response is authoritative once it lands; the (usually cached) plan snapshot answers first.
  const basicTier: boolean | null =
    live?.analyticsTier === "basic" || live?.analyticsTier === "deep"
      ? live.analyticsTier === "basic"
      : plan
        ? plan.plan === "free"
        : null;

  // Bumped by realtime share.* frames (a viewer opened or downloaded something in this workspace)
  // so the totals refresh without a reload. The frame carries no docId, so any share event in the
  // workspace triggers one lite refetch; cheap, and correct.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    return subscribeRealtime("activity", (f) => {
      if (f.type !== "activity" || typeof f.event.type !== "string") return;
      // `share.*` moves the totals; `share_link.*` changes the link summary line.
      if (f.event.type.startsWith("share.") || f.event.type.startsWith("share_link.")) setRev((r) => r + 1);
    });
  }, []);

  // The sole-link label and (as a fast fallback) the total link count. `?limit=1`: this is never
  // the source of the ranked lists below, only of the one-link header line, so it stays a one-row
  // fetch no matter how many links the document has.
  const [links, setLinks] = useState<{ total: number; links: LinkSummary[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/links?limit=1`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { total?: number; links?: LinkSummary[] };
        if (!cancelled) setLinks({ total: typeof json.total === "number" ? json.total : 0, links: Array.isArray(json.links) ? json.links : [] });
      } catch {
        // the summary line is a bonus; the tiles do not depend on it
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, rev]);

  /**
   * How many links these tiles actually cover.
   *
   * `linksTotal` (from the same analytics response as the tiles) counts live links; `byLink` can
   * additionally carry a deleted link's traffic — the tiles are `{ docId }`-scoped and include a
   * deleted link's rows by design, so a document whose second link was deleted printed "all 1
   * links" over totals that counted two. Taking the larger of the two keeps that case honest, at
   * the cost of only seeing a deleted link's slug when it made the bounded top-N ranking.
   */
  const coveredLinkCount = useMemo(() => {
    const total = typeof live?.linksTotal === "number" ? live.linksTotal : (links?.total ?? 0);
    const rankedSlugs = new Set<string>((live?.byLink ?? []).map((r) => r.shareId).filter(Boolean));
    return Math.max(total, rankedSlugs.size);
  }, [links, live]);

  /**
   * The per-link rows behind the two lists below. The server already ranked and labelled them
   * (`topLinks=N` on the analytics request) — this only reshapes the response, it does not sort or
   * resolve labels itself any more.
   *
   * A row with no label is a deleted link: its numbers are still in the tiles above, so hiding it
   * would make the lists fail to explain the totals they sit under — but it gets no link out,
   * because the metrics page has nothing to filter to.
   */
  const linkRows = useMemo(
    () =>
      (live?.byLink ?? []).map((r) => ({
        shareId: r.shareId,
        label: r.label ?? null,
        viewers: num(r.viewers),
        views: num(r.views),
        downloads: num(r.downloads),
        lastViewedAt: typeof r.lastViewedAt === "string" ? r.lastViewedAt : null,
      })),
    [live],
  );

  /**
   * Which links are working, and which are live right now — the two questions a sender actually
   * has once a document has more than one link, and neither was answerable from this card. It used
   * to print a single "most viewed" name, which says nothing about whether second place is close
   * behind or has never been opened.
   *
   * Ranked on people per link, the same quantity as the People tile, so the column adds up to the
   * number above it instead of inviting a comparison between two different kinds of thing.
   */
  const topLinks = useMemo(
    () =>
      [...linkRows]
        .filter((r) => r.viewers > 0)
        .sort((a, b) => b.viewers - a.viewers || b.views - a.views)
        .slice(0, 3),
    [linkRows],
  );

  /** Most recently opened first — "is anyone reading it *now*", which ranking by volume hides. */
  const recentLinks = useMemo(
    () =>
      [...linkRows]
        .filter((r) => Boolean(r.lastViewedAt))
        .sort((a, b) => Date.parse(b.lastViewedAt!) - Date.parse(a.lastViewedAt!))
        .slice(0, 3),
    [linkRows],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${DAYS}&lite=1&byLink=1&topLinks=${TOP_LINKS_LIMIT}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as StatsResponse;
        if (!cancelled) setLive(json);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, rev]);

  const stats = useMemo(() => {
    const t = live?.totals;
    // `viewerCount` is the unique-people figure every tier receives; older responses only carry the split.
    const viewers = typeof live?.viewerCount === "number" ? num(live.viewerCount) : t ? num(t.authenticatedViewers) + num(t.anonymousViewers) : null;
    // Both the snapshot and the live response speak the window, not lifetime, so the first paint
    // and the second show the same kind of number.
    const downloads = t ? num(t.downloads) : snapshot ? num(snapshot.lastDaysDownloads) : null;
    // In-range visit time, the same basis as the metrics page Total time; the lifetime
    // `timeSpentMs` fallback only covers a server that predates `visitTimeMs`.
    const timeMs = t
      ? typeof t.visitTimeMs === "number"
        ? num(t.visitTimeMs)
        : typeof t.timeSpentMs === "number"
          ? num(t.timeSpentMs)
          : null
      : null;
    return { viewers, downloads, timeMs };
  }, [live, snapshot]);

  const chartData = useMemo(
    () => (Array.isArray(live?.series) ? live!.series.map((s) => ({ date: s.date, value: num(s.views) })) : []),
    [live],
  );
  const hasAnyViews = chartData.some((d) => d.value > 0);
  const freshness = live ? "Live" : snapshot?.updatedAt ? `Updated ${relativeAge(snapshot.updatedAt) ?? ""}`.trim() : null;
  // Free workspaces get a clamped window; the server reports both the limit and the days it served.
  const analyticsDaysLimit =
    typeof live?.analyticsDaysLimit === "number" && Number.isFinite(live.analyticsDaysLimit) && live.analyticsDaysLimit > 0
      ? Math.floor(live.analyticsDaysLimit)
      : null;
  const clamped = analyticsDaysLimit !== null && analyticsDaysLimit < DAYS;
  const shownDays = clamped ? Math.min(analyticsDaysLimit, num(live?.days) || analyticsDaysLimit) : DAYS;

  // `truncate` on every line and `min-w-0` on the wrapper: a one-word label never wraps, so in a
  // narrow column it would otherwise paint past the column edge into the next tile.
  const tile = (
    label: string,
    value: number | null | string,
    opts?: { sub?: React.ReactNode; title?: string; className?: string },
  ) => (
    <div data-quickstats-tile className={`min-w-0 ${opts?.className ?? ""}`} title={opts?.title}>
      <div className="truncate text-[11px] font-medium text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold tabular-nums text-[var(--fg)]">
        {value === null ? "–" : typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {opts?.sub ? <div className="mt-0.5 min-h-[14px] truncate text-[10px] leading-[14px]">{opts.sub}</div> : null}
    </div>
  );

  /** The one link's label, when a document has exactly one, so the header can name what it counts. */
  const soleLinkLabel = coveredLinkCount === 1 && links?.links.length === 1 ? links.links[0]!.label : null;

  // The prop is the legacy document-level flag, which only mirrors the DEFAULT link; the response's
  // `downloadsEnabled` is "any live link allows it", and a real count always earns the tile.
  const showDownloads =
    (live?.downloadsEnabled ?? downloadsEnabled) || (typeof stats.downloads === "number" && stats.downloads > 0);

  const lastOpenedIso = typeof live?.lastViewedAt === "string" ? live.lastViewedAt : null;
  const lastOpenedMs = lastOpenedIso ? Date.parse(lastOpenedIso) : NaN;
  const lastOpenedTitle = Number.isFinite(lastOpenedMs) ? new Date(lastOpenedMs).toLocaleString() : undefined;

  // Free: the count stays, the identities are Pro. Reserve the line while the plan is unknown.
  const viewersSub =
    basicTier === null ? (
      <span className="invisible" aria-hidden="true">
        see who · Pro
      </span>
    ) : basicTier ? (
      <button
        type="button"
        className="font-medium text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
        onClick={() => openUpgrade("analytics_history")}
        title="See who opened it on Pro"
      >
        see who · Pro
      </button>
    ) : undefined;

  return (
    // Same frame and the same titled header as the links and snapshot sections of the panel: an
    // uppercase section name with an icon, the window as secondary text, freshness on the right.
    // Before this it opened with "Last 7 days" and no title, so it read as an unlabelled block.
    <section aria-label="Analytics" className="@container rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
      {/* Header rule: same on all three panel cards (links, analytics, summary), so each card's
          title reads as a title and not as the first row of its content. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--divider)] pb-3">
        <div className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
          <ChartBarIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
          <span className="truncate">Analytics</span>
          {/* Name the scope, not just the window. This card sits directly under the links panel,
              which is headed with the DEFAULT link's address and settings, so without "all N links"
              the reader takes these tiles for the default link's numbers and concludes the other
              links got nothing. "All links" is the same wording as the metrics page chip. */}
          {/* Name the scope in both cases. On a one-link document these tiles *are* that link's
              numbers, and saying so is the difference between a reader knowing that and guessing —
              the link lists below are hidden at one link, so nothing else on the card says it. */}
          <span className="font-normal normal-case tracking-normal text-[var(--muted)]">
            {coveredLinkCount > 1
              ? `· all ${coveredLinkCount} links · `
              : soleLinkLabel
                ? `· ${soleLinkLabel} · `
                : "· "}
            last {shownDays} days
          </span>
        </div>
        <div className="text-[11px] text-[var(--muted-2)]">{failed ? "Live stats unavailable" : (freshness ?? "")}</div>
      </div>

      {/* Sized by the card, not the viewport: on a wide screen the card sits in a ~260px rail, so
          a viewport breakpoint squeezed four columns into it and truncated the labels. */}
      <div data-quickstats-tiles className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 @md:grid-cols-4">
        {tile("People", stats.viewers, { sub: viewersSub })}
        {tile("Time", stats.timeMs === null ? null : formatDurationMs(stats.timeMs), {
          title: `Time people spent with it open in the last ${shownDays} days`,
        })}
        {tile("Last opened", relativeAge(lastOpenedIso) ?? "—", {
          title: lastOpenedTitle,
          className: showDownloads ? undefined : "col-span-2",
        })}
        {showDownloads ? tile("Downloads", stats.downloads) : null}
      </div>

      {/* Only once there is more than one link: on a single-link document both lists would be the
          same one row, restating the tiles above. */}
      {coveredLinkCount > 1 && (topLinks.length || recentLinks.length) ? (
        <div data-linklists className="mt-3 grid gap-x-6 gap-y-3 border-t border-[var(--divider)] pt-3 @md:grid-cols-2">
          <LinkMiniList
            title="Links by people"
            docId={docId}
            rows={topLinks}
            empty="No link opened yet"
            right={(r) => <span className="tabular-nums">{r.viewers.toLocaleString()}</span>}
          />
          <LinkMiniList
            title="Recently opened"
            docId={docId}
            rows={recentLinks}
            empty="Nothing opened yet"
            right={(r) => <span className="whitespace-nowrap">{relativeAge(r.lastViewedAt) ?? "—"}</span>}
          />
        </div>
      ) : null}

      {/* Its own section, divided like the link lists above, with the caption on top naming what the
          bars count (it used to sit under the chart, beside the metrics link). */}
      <div className="mt-3 border-t border-[var(--divider)] pt-3">
        <div className="mb-1 text-[11px] font-medium text-[var(--muted)]">People by day</div>
        {chartData.length ? (
          hasAnyViews ? (
            <DailyArea data={chartData} unit={["person", "people"]} />
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--muted)]">
              No one opened it in the last {shownDays} days.
            </div>
          )
        ) : (
          <div className="h-24 animate-pulse rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
        )}
      </div>

      {/* One footer row. Free used to get a second upsell line here on top of "see who · Pro" under
          People; the tile is where the missing identities are felt, so the upsell lives there only.
          The limited window is already in the header ("last 7 days"). */}
      <div className="mt-3 flex justify-end text-[11px]">
        <Link
          href={`/doc/${encodeURIComponent(docId)}/metrics`}
          className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
        >
          Open full metrics →
        </Link>
      </div>
    </section>
  );
}
