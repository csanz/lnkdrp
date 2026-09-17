/**
 * "People by day" smooth area chart over the range, with the count printed on the days that matter
 * (the look chosen for every analytics chart in the app; bars read as sticks). Day keys are calendar days in the viewer's time zone
 * (the reading API buckets them with `tz`), so they are formatted as plain dates, never shifted.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Area, AreaChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts";
import { valueLabels } from "@/components/charts/ChartValueLabel";

/** One day: `day` is "YYYY-MM-DD" in the viewer's time zone. */
export type ActivityPoint = { day: string; people: number };

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

const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Aug 30" for "2026-08-30"; unparseable keys come back unchanged. */
export function formatLocalDayKey(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return dayFormatter.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

function peopleText(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ActivityPoint }> }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] shadow-sm">
      {`${formatLocalDayKey(point.day)} · ${peopleText(point.people)}`}
    </div>
  );
}

/** Chart card body. */
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
  } else if (!series.some((p) => p.people > 0)) {
    body = <div className="flex h-[160px] items-center justify-center text-[13px] text-[var(--muted)]">No activity in this range.</div>;
  } else {
    const data = series.map((p) => ({ day: p.day, people: Number.isFinite(p.people) ? Math.max(0, p.people) : 0 }));
    const maxTicks = narrow ? 4 : 8;
    const interval = Math.max(0, Math.ceil(data.length / maxTicks) - 1);
    body = (
      <div ref={wrapRef} className="h-[160px] w-full">
        {width > 0 ? (
          <AreaChart width={width} height={160} data={data} margin={{ top: 18, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="lnkdrpActivityPeople" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={EMERALD} stopOpacity={0.24} />
                <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, "dataMax"]} />
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
            <XAxis
              dataKey="day"
              interval={interval}
              tickLine={false}
              axisLine={false}
              height={18}
              // First and last dates anchor to their outer edge so the card never clips them ("ug 18").
              tick={(props: { x: number; y: number; index?: number; visibleTicksCount?: number; payload: { value: string } }) => {
                const last = (props.visibleTicksCount ?? 0) - 1;
                const anchor = props.index === 0 ? "start" : props.index === last ? "end" : "middle";
                return (
                  <text x={props.x} y={props.y + 10} textAnchor={anchor} fontSize={10} fill="var(--muted)">
                    {formatLocalDayKey(props.payload.value)}
                  </text>
                );
              }}
            />
            <Tooltip cursor={{ stroke: "var(--border)", strokeOpacity: 0.35 }} content={<ChartTooltip />} />
            <Area
              type="monotone"
              dataKey="people"
              stroke={EMERALD}
              strokeWidth={1.5}
              fill="url(#lnkdrpActivityPeople)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 1.5 }}
              isAnimationActive={false}
            >
              <LabelList dataKey="people" content={valueLabels({ values: data.map((d) => d.people) })} />
            </Area>
          </AreaChart>
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
