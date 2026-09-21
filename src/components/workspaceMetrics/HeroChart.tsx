"use client";

/**
 * The hero chart on `/metrics`: the selected headline figure by day across the range.
 *
 * A smooth emerald area with count labels, like every other metrics chart in the app — never bars
 * (docs/prds/lnkdrp-workspace-metrics.md, "Lessons carried in"). Two details are copied from the
 * document metrics chart rather than from the small sparkline, because this one runs to 90 points:
 *
 * - the dates are an HTML row under the plot (at most seven, evenly picked), not an XAxis tick per
 *   day, which collides at 90 days and is too sparse at three;
 * - the wrapper is a fixed height measured with a `ResizeObserver`, so the card is the same size
 *   before and after the data arrives and the page never shifts under the reader.
 *
 * The observer is bound by a **callback ref**, not by a mount effect. The measured node only exists
 * on the branch that has data, so an effect with an empty dependency list ran once against `null`
 * and never again: a workspace whose default window was empty kept `size === null`, and switching to
 * a range that did have traffic rendered the wrapper, the date row and no plot at all.
 */
import { useCallback, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts";

import { valueLabels } from "@/components/charts/ChartValueLabel";
import { formatDayKey } from "@/lib/format/date";
import type { WorkspaceSeriesPoint } from "@/lib/analytics/workspace/types";
import { METRIC_META, formatMetricCompact, formatMetricPoint, seriesValues, type MetricKey } from "./format";

/** Plot height; the date row and the card padding sit outside it. */
const PLOT_HEIGHT_CLASS = "h-56";
/** At most this many dates under the plot, evenly picked, so 90 days stays readable. */
const MAX_TICKS = 7;
/** Width one date needs to itself. Seven dates fit a desktop card; at 390px only four do. */
const TICK_WIDTH_PX = 64;

/** The selected metric drawn by day: a smooth emerald area with count labels. */
export default function HeroChart({
  series,
  metric,
  rangeDays,
}: {
  series: WorkspaceSeriesPoint[];
  metric: MetricKey;
  rangeDays: number;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Attach on mount of the plot wrapper, detach when it goes away: React calls this with the node
  // and then with `null`, which is exactly the lifecycle the observer needs to follow.
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

  const meta = METRIC_META[metric];
  const values = seriesValues(series, metric);
  const data = series.map((p, i) => ({ day: p.day, value: values[i] ?? 0 }));
  const hasAny = values.some((v) => v > 0);
  const first = series[0]?.day ?? "";
  const last = series[series.length - 1]?.day ?? "";

  return (
    <section aria-label={meta.chartTitle} className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold text-[var(--fg)]">{meta.chartTitle}</h2>
        {first && last ? (
          <span className="text-[11px] tabular-nums text-[var(--muted-2)]">
            {formatDayKey(first)} – {formatDayKey(last)}
          </span>
        ) : null}
      </div>

      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        {!hasAny ? (
          <div
            className={`${PLOT_HEIGHT_CLASS} grid w-full place-items-center rounded-lg border border-dashed border-[var(--border)] px-3 text-center text-[12px] text-[var(--muted)]`}
          >
            No {meta.label.toLowerCase()} yet in the last {rangeDays} days. Share a link to start tracking.
          </div>
        ) : (
          <>
            <div ref={setWrap} className={`${PLOT_HEIGHT_CLASS} w-full`}>
              {size ? (
                <AreaChart width={size.w} height={size.h} data={data} margin={{ top: 18, right: 8, bottom: 4, left: 8 }}>
                  <defs>
                    <linearGradient id="lnkdrpWorkspaceMetricsFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-views)" stopOpacity={0.28} />
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
                    formatter={(v: unknown) => [typeof v === "number" ? formatMetricPoint(metric, v) : String(v), ""]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--chart-views)"
                    strokeWidth={1.5}
                    fill="url(#lnkdrpWorkspaceMetricsFill)"
                    fillOpacity={1}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 1.5 }}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey="value"
                      content={valueLabels({ values, format: (n) => formatMetricCompact(metric, n) })}
                    />
                  </Area>
                </AreaChart>
              ) : null}
            </div>
            <DateRow days={series.map((p) => p.day)} width={size?.w ?? 0} />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The date row under the plot. Positioned by percentage inside the plot's own inset (8px each side,
 * like `mx-2`) so each date sits under its point; the first and last shift inward so the card edge
 * cannot clip them.
 */
function DateRow({ days, width }: { days: string[]; width: number }) {
  const n = days.length;
  if (!n) return null;
  // How many dates the plot is wide enough for, never more than MAX_TICKS. Without this the
  // 390px card printed seven dates over each other ("Aug 19Aug 24").
  const maxTicks = Math.max(2, Math.min(MAX_TICKS, Math.floor((width || 600) / TICK_WIDTH_PX)));
  const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
  return (
    <div className="relative mx-2 mt-3 h-4 text-[10px] tabular-nums text-[var(--muted)]">
      {days.map((day, i) => {
        if (n > 1 && i % step !== 0 && i !== n - 1) return null;
        // Drop a penultimate tick that would crowd the last one.
        if (n > 1 && i !== n - 1 && n - 1 - i < step / 2) return null;
        const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
        const shift = n > 1 && i === 0 ? "0%" : n > 1 && i === n - 1 ? "-100%" : "-50%";
        return (
          <span key={`tick:${day}`} className="absolute top-0 whitespace-nowrap" style={{ left: `${pct}%`, transform: `translateX(${shift})` }}>
            {formatDayKey(day)}
          </span>
        );
      })}
    </div>
  );
}
