"use client";

/**
 * The by-day work chart, shared by every surface that summarises activity.
 *
 * It was private to `src/app/(app)/activity/StatsHeader.tsx` until the contributor pages
 * (`/people/:userId`, `/agents/:client/:ownerUserId`) wanted the same picture under their own
 * tiles. Two charts of the same series would have drifted - a different line width here, a
 * different tick count there - and a reader moving from the workspace header to one agent's page
 * would have had to re-learn the form. So it moved out whole rather than being written twice, and
 * the activity header now imports what it used to declare.
 *
 * It draws only; it fetches nothing and knows nothing about windows or actors. The caller decides
 * which days it covers and says so in its own copy: this component is handed a filled series and
 * the counts for the same window, and `days` only so the screen-reader line can name the span.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import { formatDayKey } from "@/lib/format/date";
import { ACTIVITY_SUMMARY_BUCKETS, type ActivityDayPoint, type ActivitySummaryCountKey } from "@/lib/activity/summary";

/** At most this many dates under the chart, evenly picked, so 30 days stays readable. */
const TICK_COUNT = 5;

/**
 * The tooltip surface every chart in the app uses.
 *
 * Exported because the activity header's donut sits beside this chart and must not invent a second
 * tooltip: one card showing two differently framed popovers reads as two components, not one.
 */
export const TOOLTIP_STYLE = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "6px 8px",
  fontSize: 12,
  color: "var(--fg)",
} as const;

/** One colour per counted kind of work, in the order the tiles are shown. */
const BUCKET_COLORS: Record<ActivitySummaryCountKey, string> = {
  docsAdded: "var(--chart-views)",
  docsReplaced: "var(--chart-work-2)",
  linksCreated: "var(--chart-work-3)",
  docsRemoved: "var(--chart-work-4)",
  projectsCreated: "var(--chart-work-5)",
};

/**
 * Each kind of work by day, one line per tile in the tile's colour.
 *
 * Lines rather than one stacked shape: the reader's question here is "which of these is happening",
 * and five kinds on one axis only separate if each keeps its own line. A kind with nothing in the
 * window is left out entirely rather than drawn flat along the floor. The wrapper is measured with
 * a ResizeObserver, like the metrics hero, so the card keeps its height while the data loads.
 */
export default function WorkChart({
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

/**
 * At most `count` evenly spaced day keys, first and last always included.
 *
 * Exported so the label rail under the chart can be pinned by a test without rendering recharts,
 * which is the only part of this file a node test can reach.
 */
export function pickTicks(series: ActivityDayPoint[], count: number): string[] {
  if (series.length <= count) return series.map((p) => p.day);
  const step = (series.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => series[Math.round(i * step)]!.day);
}
