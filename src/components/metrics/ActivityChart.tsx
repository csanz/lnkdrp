/**
 * "People by day" bar chart over the range, from the share views series.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bar, BarChart, LabelList, Tooltip, XAxis } from "recharts";
import { formatDayKey } from "@/lib/format/date";

export type ActivityPoint = { date: string; views: number };

export type ActivityChartProps = {
  series: ActivityPoint[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
};

const EMERALD = "rgb(16 185 129)";
const NARROW_QUERY = "(max-width: 639px)";

function subscribeNarrow(cb: () => void) {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function peopleText(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ActivityPoint }> }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] shadow-sm">
      {`${formatDayKey(point.date)} · ${peopleText(point.views)}`}
    </div>
  );
}

/** Bar chart card body. */
export default function ActivityChart({ series, loading, error, onRetry }: ActivityChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [series, loading, error]);

  let body: React.ReactNode;
  if (error && !series) {
    body = (
      <div className="flex h-[160px] flex-col items-center justify-center gap-2 text-[13px] text-[var(--muted)]">
        {"Couldn't load activity."}
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
        >
          Try again
        </button>
      </div>
    );
  } else if (!series) {
    body = <div className="h-[160px] animate-pulse rounded-xl bg-[var(--panel-hover)]" aria-busy={loading} />;
  } else if (!series.some((p) => p.views > 0)) {
    body = <div className="flex h-[160px] items-center justify-center text-[13px] text-[var(--muted)]">No activity in this range.</div>;
  } else {
    const data = series.map((p) => ({ date: p.date, views: Number.isFinite(p.views) ? Math.max(0, p.views) : 0 }));
    const maxTicks = narrow ? 4 : 8;
    const interval = Math.max(0, Math.ceil(data.length / maxTicks) - 1);
    body = (
      <div ref={wrapRef} className="h-[160px] w-full">
        {width > 0 ? (
          <BarChart width={width} height={160} data={data} margin={{ top: 16, right: 4, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatDayKey(d)}
              interval={interval}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--muted)" }}
              height={18}
            />
            <Tooltip cursor={{ fill: "var(--panel-hover)" }} content={<ChartTooltip />} />
            <Bar dataKey="views" fill={EMERALD} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false}>
              {data.length <= 31 ? (
                <LabelList
                  dataKey="views"
                  position="top"
                  fontSize={10}
                  fill="var(--muted)"
                  formatter={(v: unknown) => (typeof v === "number" && v > 0 ? v : "")}
                />
              ) : null}
            </Bar>
          </BarChart>
        ) : null}
      </div>
    );
  }

  return (
    <section data-activity className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--fg)]">People by day</h2>
      <p className="mt-0.5 text-[12px] text-[var(--muted)]">Each person counts on the day they last opened it.</p>
      <div className="mt-3">{body}</div>
    </section>
  );
}
