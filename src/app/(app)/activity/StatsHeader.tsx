"use client";

/**
 * The stats header above the `/activity` feed.
 *
 * Two halves of one question. Left: what was done in the window — documents added, replaced,
 * archived or deleted, links and projects created. Right: who did it, as a donut with one slice per
 * agent client and one for everything people did in the app.
 *
 * What it deliberately does not show: views, opens and downloads. Those are how a document
 * performed, which is `/metrics`; this page is what happened in the workspace. The split is enforced
 * in `src/lib/activity/summary.ts`, not here.
 *
 * It is a header, not a dashboard: one card, a fixed 30-day window named in the copy so no number is
 * ambiguous, and nothing at all when the workspace has done nothing yet (the feed's own empty state
 * speaks instead). The donut disappears too when every action was a person's — a circle of one
 * colour says nothing that the counts have not already said.
 *
 * The numbers are workspace-wide for the window and do not follow the feed's filters: the donut
 * answers "agents or us", which a "Who: agents" filter would reduce to a single slice.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { subscribeRealtime } from "@/lib/client/realtime";
import { Area, AreaChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts";

import { valueLabels } from "@/components/charts/ChartValueLabel";
import { formatDayKey } from "@/lib/format/date";
import { formatShare } from "@/lib/charts/donut";
import {
  ACTIVITY_SUMMARY_BUCKETS,
  emptyCounts,
  type ActivityDayPoint,
  type ActorSlice,
  type ActivitySummaryCountKey,
} from "@/lib/activity/summary";

/** Window the header covers. Fixed on purpose — a range control would make this a dashboard. */
const DAYS = 30;
/** Minimum spacing between refreshes triggered by live activity frames. */
const REFRESH_MIN_MS = 15_000;

/** At most this many dates under the chart, evenly picked, so 30 days stays readable. */
const TICK_COUNT = 5;

/**
 * Slice colours, in the order the API returns slices (people first, then agent clients by volume).
 *
 * Three categorical hues, validated as a set against both surfaces; the folded tail and anything
 * past the third slot take the de-emphasis grey rather than a generated hue.
 */
const SLICE_COLORS = ["var(--chart-actor-1)", "var(--chart-actor-2)", "var(--chart-actor-3)"] as const;
const REST_COLOR = "var(--chart-actor-rest)";

/** Colour for the slice at `index`: its hue while the hues last, the de-emphasis grey after that. */
function sliceColor(slice: ActorSlice, index: number): string {
  if (slice.kind === "other") return REST_COLOR;
  return SLICE_COLORS[index] ?? REST_COLOR;
}

type SummaryResponse = {
  days: number;
  counts: Record<ActivitySummaryCountKey, number>;
  actors: { total: number; people: number; agents: number; slices: ActorSlice[] };
  series: ActivityDayPoint[];
};

/** `3 actions` / `1 action`. */
function actionsLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "action" : "actions"}`;
}

/** The counts and the actor donut for the last {@link DAYS} days, or nothing when there is neither. */
export default function ActivityStatsHeader() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const lastFetchRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    lastFetchRef.current = Date.now();
    try {
      const res = await fetchWithTempUser(`/api/activity/summary?days=${DAYS}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as SummaryResponse | null;
      if (!json || typeof json !== "object") return;
      setData({
        days: typeof json.days === "number" ? json.days : DAYS,
        counts: { ...emptyCounts(), ...(json.counts ?? {}) },
        series: Array.isArray(json.series) ? json.series : [],
        actors: {
          total: json.actors?.total ?? 0,
          people: json.actors?.people ?? 0,
          agents: json.actors?.agents ?? 0,
          slices: Array.isArray(json.actors?.slices) ? json.actors.slices : [],
        },
      });
    } catch {
      // The feed below is unaffected; the header simply stays as it was (or absent on first load).
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    // Live: every frame that can change these numbers refreshes them - a new activity row, an
    // upload finishing, a project created. Spaced, so a burst of frames is one refetch.
    const onFrame = () => {
      const since = Date.now() - lastFetchRef.current;
      if (since >= REFRESH_MIN_MS) {
        void load();
        return;
      }
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load();
      }, REFRESH_MIN_MS - since);
    };
    const unsubscribes = (["activity", "upload", "project", "doc"] as const).map((t) => subscribeRealtime(t, onFrame));
    return () => {
      cancelled = true;
      unsubscribes.forEach((fn) => fn());
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  if (loading) {
    // Reserves the card's height so the first feed row does not jump once the numbers land.
    return <div aria-hidden="true" className="mb-6 h-[104px] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] motion-safe:animate-pulse" />;
  }
  if (!data) return null;

  const counts = data.counts;
  const total = data.actors.total;
  // Nothing has happened here yet: the feed's own empty state is the whole message.
  if (!total && ACTIVITY_SUMMARY_BUCKETS.every((b) => !counts[b.id])) return null;

  const slices = data.actors.slices;
  // One slice tells a reader nothing the counts have not: it is all the same hands.
  const showActors = slices.length > 1;

  return (
    <section aria-label={`What happened in the last ${data.days} days`} className="mb-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
            Last {data.days} days
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--muted-2)]">{actionsLabel(total)}</span>
        </div>

        <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <dl className="flex min-w-0 flex-1 flex-wrap items-start gap-x-7 gap-y-3">
            {ACTIVITY_SUMMARY_BUCKETS.map((b) => (
              <div key={b.id} className="min-w-0">
                <dd className="text-[20px] font-semibold leading-6 tabular-nums text-[var(--fg)]">
                  {counts[b.id].toLocaleString()}
                </dd>
                <dt className="mt-0.5 text-[11px] leading-4 text-[var(--muted-2)]">{b.label}</dt>
              </div>
            ))}
          </dl>

          {slices.length ? <ActorLegend slices={slices} total={total} /> : null}
        </div>

        {data.series.length ? <ActionsChart series={data.series} days={data.days} /> : null}

        <p className="mt-3 text-[11px] leading-4 text-[var(--muted-2)]">
          {showActors
            ? "What was done in this workspace, and who did it. Views and downloads are on Metrics."
            : "What was done in this workspace. Views and downloads are on Metrics."}
        </p>
      </div>
    </section>
  );
}

/**
 * Who did the work, as a compact list.
 *
 * The chart below carries the shape of the window; this carries the names. Colour never stands
 * alone: every row has its label, its count and its share.
 */
function ActorLegend({ slices, total }: { slices: ActorSlice[]; total: number }) {
  return (
    <ul className="min-w-0 shrink-0 space-y-1.5 sm:w-52">
      {slices.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2 text-[12px] leading-4">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: sliceColor(s, i) }} />
          <span className="min-w-0 truncate text-[var(--muted)]">{s.label}</span>
          <span className="ml-auto shrink-0 pl-2 tabular-nums font-medium text-[var(--fg)]">{s.count.toLocaleString()}</span>
          <span className="w-9 shrink-0 text-right tabular-nums text-[var(--muted-2)]">{formatShare(s.count / total)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Actions per day across the window: the same smooth emerald area the metrics charts use, with
 * count labels and the dates as a row underneath rather than an axis tick per day.
 *
 * Agents and people are one line, not two: the question this page answers first is "how much
 * happened here", and the split by hands is the legend beside it (and the tooltip, which names
 * both). The wrapper is measured with a ResizeObserver, like the metrics hero, so the card is the
 * same height before and after the numbers land.
 */
function ActionsChart({ series, days }: { series: ActivityDayPoint[]; days: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const setWrap = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
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
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  const values = series.map((p) => p.total);
  const busiest = values.reduce((a, b) => Math.max(a, b), 0);
  // A flat empty window would draw a line along the floor and say nothing.
  if (!busiest) return null;
  const ticks = pickTicks(series, TICK_COUNT);

  return (
    <div className="mt-4">
      <div ref={setWrap} className="h-28 w-full">
        {size ? (
          <AreaChart width={size.w} height={size.h} data={series} margin={{ top: 16, right: 6, bottom: 2, left: 6 }}>
            <defs>
              <linearGradient id="lnkdrpActivityActionsFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-views)" stopOpacity={0.26} />
                <stop offset="100%" stopColor="var(--chart-views)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, "dataMax"]} />
            <XAxis dataKey="day" hide />
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
              labelFormatter={(label: unknown) => formatDayKey(String(label ?? ""))}
              formatter={(value: unknown, _name: unknown, entry: unknown) => {
                const point = (entry as { payload?: ActivityDayPoint } | undefined)?.payload;
                const n = typeof value === "number" ? value : 0;
                const split = point ? ` (${point.agents.toLocaleString()} by agents, ${point.people.toLocaleString()} in the app)` : "";
                return [`${n.toLocaleString()}${split}`, "Actions"];
              }}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke="var(--chart-views)"
              strokeWidth={1.5}
              fill="url(#lnkdrpActivityActionsFill)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 1.5 }}
              isAnimationActive={false}
            >
              <LabelList dataKey="total" content={valueLabels({ values })} />
            </Area>
          </AreaChart>
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between px-1 text-[10px] tabular-nums text-[var(--muted-2)]">
        {ticks.map((t) => (
          <span key={t}>{formatDayKey(t)}</span>
        ))}
      </div>
      <span className="sr-only">{`Actions per day over the last ${days} days; busiest day ${busiest}.`}</span>
    </div>
  );
}

/** At most `count` evenly spaced day keys, first and last always included. */
function pickTicks(series: ActivityDayPoint[], count: number): string[] {
  if (series.length <= count) return series.map((p) => p.day);
  const step = (series.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => series[Math.round(i * step)]!.day);
}
