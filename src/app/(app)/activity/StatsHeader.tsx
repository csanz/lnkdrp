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
import { CartesianGrid, Cell, Label, Line, LineChart, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";

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

/** Outer size and ring thickness of the actor donut, in px. */
const DONUT_SIZE = 104;
const DONUT_THICKNESS = 14;

/** The tooltip surface every chart in the app uses. */
const TOOLTIP_STYLE = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "6px 8px",
  fontSize: 12,
  color: "var(--fg)",
} as const;

/**
 * Slice colours, in the order the API returns slices (people first, then agent clients by volume).
 *
 * Three categorical hues, validated as a set against both surfaces; the folded tail and anything
 * past the third slot take the de-emphasis grey rather than a generated hue.
 */
const SLICE_COLORS = ["var(--chart-actor-1)", "var(--chart-actor-2)", "var(--chart-actor-3)"] as const;

/** One colour per counted kind of work, in the order the tiles are shown. */
const BUCKET_COLORS: Record<ActivitySummaryCountKey, string> = {
  docsAdded: "var(--chart-views)",
  docsReplaced: "var(--chart-work-2)",
  linksCreated: "var(--chart-work-3)",
  docsRemoved: "var(--chart-work-4)",
  projectsCreated: "var(--chart-work-5)",
};
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

          {showActors ? <ActorDonut slices={slices} total={total} days={data.days} /> : null}
        </div>

        {data.series.length ? <WorkChart series={data.series} counts={counts} days={data.days} /> : null}

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
 * Who did the work: a recharts donut and its legend, the same library the metrics charts use.
 *
 * The legend is not decoration - it carries every slice's name and count, so identity never rests
 * on colour alone, and the total sits inside the ring for the shares to add up to.
 */
function ActorDonut({ slices, total, days }: { slices: ActorSlice[]; total: number; days: number }) {
  const data = slices.map((s, i) => ({ key: s.key, label: s.label, value: s.count, fill: sliceColor(s, i) }));
  if (!data.length) return null;
  const summary = slices.map((s) => `${s.label} ${formatShare(s.count / total)}`).join(", ");

  return (
    <div className="flex shrink-0 items-center gap-4">
      <div
        className="shrink-0"
        style={{ width: DONUT_SIZE, height: DONUT_SIZE }}
        role="img"
        aria-label={`Who did the work in the last ${days} days: ${summary}`}
      >
        <PieChart width={DONUT_SIZE} height={DONUT_SIZE}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={DONUT_SIZE / 2 - DONUT_THICKNESS}
            outerRadius={DONUT_SIZE / 2}
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={d.fill} />
            ))}
            <Label
              position="center"
              content={({ viewBox }) => {
                const box = viewBox as { cx?: number; cy?: number } | undefined;
                if (typeof box?.cx !== "number" || typeof box?.cy !== "number") return null;
                return (
                  <g>
                    <text x={box.cx} y={box.cy - 2} textAnchor="middle" dominantBaseline="middle" className="fill-[var(--fg)] text-[15px] font-semibold tabular-nums">
                      {total.toLocaleString()}
                    </text>
                    <text x={box.cx} y={box.cy + 12} textAnchor="middle" dominantBaseline="middle" className="fill-[var(--muted-2)] text-[9px] uppercase tracking-[0.08em]">
                      actions
                    </text>
                  </g>
                );
              }}
            />
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--fg)" }}
            formatter={(value: unknown, name: unknown) => [
              `${typeof value === "number" ? value.toLocaleString() : String(value)} (${formatShare((typeof value === "number" ? value : 0) / total)})`,
              String(name ?? ""),
            ]}
          />
        </PieChart>
      </div>
      <ul className="min-w-0 space-y-1.5">
        {slices.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 text-[12px] leading-4">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: sliceColor(s, i) }} />
            {/* An agent's name says nothing about what it is. The chip does, in the same place the
                workspace metrics list marks one, so "Northwind Seed" is not read as a colleague. */}
            {s.kind === "people" ? null : (
              <span
                className="shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)] ring-1 ring-[var(--border)]"
                title="Worked through the MCP, not in the app"
              >
                Agent
              </span>
            )}
            <span className="min-w-0 truncate text-[var(--muted)]">{s.label}</span>
            <span className="ml-auto shrink-0 pl-2 tabular-nums font-medium text-[var(--fg)]">{s.count.toLocaleString()}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-[var(--muted-2)]">{formatShare(s.count / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Each kind of work by day, one line per tile in the tile's colour.
 *
 * Lines rather than one stacked shape: the reader's question here is "which of these is happening",
 * and five kinds on one axis only separate if each keeps its own line. A kind with nothing in the
 * window is left out entirely rather than drawn flat along the floor. The wrapper is measured with
 * a ResizeObserver, like the metrics hero, so the card keeps its height while the data loads.
 */
function WorkChart({
  series,
  counts,
  days,
}: {
  series: ActivityDayPoint[];
  counts: Record<ActivitySummaryCountKey, number>;
  days: number;
}) {
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

  const shown = ACTIVITY_SUMMARY_BUCKETS.filter((b) => counts[b.id] > 0);
  if (!shown.length) return null;
  const ticks = pickTicks(series, TICK_COUNT);

  return (
    <div className="mt-4">
      <div ref={setWrap} className="h-32 w-full">
        {size ? (
          <LineChart width={size.w} height={size.h} data={series} margin={{ top: 10, right: 6, bottom: 2, left: 6 }}>
            <YAxis hide domain={[0, "dataMax"]} allowDecimals={false} />
            <XAxis dataKey="day" hide />
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
            <Tooltip
              cursor={{ stroke: "var(--border)", strokeOpacity: 0.35 }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: "var(--muted-2)" }}
              itemStyle={{ color: "var(--fg)" }}
              labelFormatter={(label: unknown) => formatDayKey(String(label ?? ""))}
              formatter={(value: unknown, name: unknown) => [typeof value === "number" ? value.toLocaleString() : String(value), String(name ?? "")]}
            />
            {shown.map((b) => (
              <Line
                key={b.id}
                type="monotone"
                dataKey={b.id}
                name={b.label}
                stroke={BUCKET_COLORS[b.id]}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between px-1 text-[10px] tabular-nums text-[var(--muted-2)]">
        {ticks.map((t) => (
          <span key={t}>{formatDayKey(t)}</span>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {shown.map((b) => (
          <li key={b.id} className="flex items-center gap-1.5 text-[11px] leading-4 text-[var(--muted-2)]">
            <span aria-hidden="true" className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: BUCKET_COLORS[b.id] }} />
            {b.label}
          </li>
        ))}
      </ul>
      <span className="sr-only">{`Each kind of work by day over the last ${days} days.`}</span>
    </div>
  );
}

/** At most `count` evenly spaced day keys, first and last always included. */
function pickTicks(series: ActivityDayPoint[], count: number): string[] {
  if (series.length <= count) return series.map((p) => p.day);
  const step = (series.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => series[Math.round(i * step)]!.day);
}
