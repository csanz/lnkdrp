"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, Tooltip, YAxis } from "recharts";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Quick engagement stats for the owner's document page side panel.
 *
 * Renders instantly from the denormalized `Doc.metricsSnapshot` (rolled up by the doc-metrics
 * cron), then refreshes from `/api/docs/:docId/shareviews?lite=1` for live totals and the
 * views-by-day series that feeds the chart. Single series, so no legend; the title names it.
 */

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
  totals?: {
    views?: number;
    downloads?: number;
    pagesViewed?: number;
    authenticatedViewers?: number;
    anonymousViewers?: number;
  };
  series?: Array<{ date: string; views: number; downloads: number }>;
};

const DAYS = 15;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function formatDayLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return isoDay;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
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

function ViewsSparkline({ series }: { series: Array<{ date: string; views: number }> }) {
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

  const data = series.map((s) => ({ date: s.date, value: num(s.views) }));
  const ticks = series.length
    ? [series[0]?.date, series[Math.floor((series.length - 1) / 2)]?.date, series[series.length - 1]?.date].filter(Boolean)
    : [];

  return (
    <div className="w-full">
      <div ref={wrapRef} className="h-24 w-full">
        {size ? (
          <AreaChart width={size.w} height={size.h} data={data} margin={{ top: 4, right: 4, bottom: 2, left: 4 }}>
            <defs>
              <linearGradient id="lnkdrpQuickStatsViews" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-views)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--chart-views)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, "dataMax"]} />
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
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
              formatter={(v: unknown) => [typeof v === "number" ? `${v.toLocaleString()} views` : String(v), ""]}
              labelFormatter={(label: unknown) => formatDayLabel(String(label ?? ""))}
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
            />
          </AreaChart>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--muted-2)]">
        {ticks.map((t, i) => (
          <span key={`${t}:${i}`}>{formatDayLabel(String(t))}</span>
        ))}
      </div>
    </div>
  );
}

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/shareviews?days=${DAYS}&lite=1`, {
          cache: "no-store",
        });
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
  }, [docId]);

  const stats = useMemo(() => {
    const t = live?.totals;
    const viewers = t ? num(t.authenticatedViewers) + num(t.anonymousViewers) : null;
    const views = t ? num(t.views) : snapshot ? num(snapshot.lastDaysViews) : null;
    const downloads = t ? num(t.downloads) : snapshot ? num(snapshot.downloadsTotal) : null;
    const pages = t ? num(t.pagesViewed) : null;
    return { viewers, views, downloads, pages };
  }, [live, snapshot]);

  const series = useMemo(
    () => (Array.isArray(live?.series) ? live!.series.map((s) => ({ date: s.date, views: num(s.views) })) : []),
    [live],
  );
  const hasAnyViews = series.some((s) => s.views > 0);
  const freshness = live ? "Live" : snapshot?.updatedAt ? `Updated ${relativeAge(snapshot.updatedAt) ?? ""}`.trim() : null;
  // Free workspaces get a clamped window; the server reports both the limit and the days it served.
  const analyticsDaysLimit =
    typeof live?.analyticsDaysLimit === "number" && Number.isFinite(live.analyticsDaysLimit) && live.analyticsDaysLimit > 0
      ? Math.floor(live.analyticsDaysLimit)
      : null;
  const clamped = analyticsDaysLimit !== null && analyticsDaysLimit < DAYS;
  const shownDays = clamped ? Math.min(analyticsDaysLimit, num(live?.days) || analyticsDaysLimit) : DAYS;

  const tile = (label: string, value: number | null | string) => (
    <div className="min-w-0">
      <div className="text-[11px] font-medium text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold tabular-nums text-[var(--fg)]">
        {value === null ? "–" : typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );

  return (
    <section aria-label="Quick stats" className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[12px] font-medium text-[var(--fg)]">Last {shownDays} days</div>
        <div className="text-[11px] text-[var(--muted-2)]">{failed ? "Live stats unavailable" : (freshness ?? "")}</div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
        {tile("Viewers", stats.viewers)}
        {tile("Views", stats.views)}
        {tile("Downloads", downloadsEnabled ? stats.downloads : "Off")}
        {tile("Pages", stats.pages)}
      </div>

      <div className="mt-3">
        {series.length ? (
          hasAnyViews ? (
            <ViewsSparkline series={series} />
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--muted)]">
              No views yet in the last {shownDays} days. Share the link to start tracking.
            </div>
          )
        ) : (
          <div className="h-24 animate-pulse rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span className="text-[var(--muted-2)]">Views by day</span>
        <Link
          href={`/doc/${encodeURIComponent(docId)}/metrics`}
          className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
        >
          Open metrics
        </Link>
      </div>

      {clamped ? (
        <div className="mt-2 text-[11px] text-[var(--muted-2)]">
          Free shows the last {analyticsDaysLimit} days ·{" "}
          <Link href="/pricing" className="font-medium text-[var(--fg)] underline-offset-2 hover:underline">
            Upgrade for full history
          </Link>
        </div>
      ) : null}
    </section>
  );
}
