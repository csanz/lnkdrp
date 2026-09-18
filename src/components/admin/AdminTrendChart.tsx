"use client";

/**
 * The admin home's headline chart: one deployment-wide metric by day.
 *
 * A smooth area with a soft fill, like every other chart in the app — never bars. The metric is
 * picked by the tiles above it, so the chart is one series at a time rather than four overlapping
 * lines nobody can read.
 */
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type TrendPoint = { day: string; views: number; docs: number; users: number; aiRuns: number };
export type TrendMetric = keyof Omit<TrendPoint, "day">;

const LABELS: Record<TrendMetric, string> = {
  views: "Views",
  docs: "Documents",
  users: "Signups",
  aiRuns: "AI runs",
};

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : day;
}

/** At most seven dates under the plot, evenly picked, so 90 days stays readable. */
function ticks(points: TrendPoint[], max = 7): Set<string> {
  if (points.length <= max) return new Set(points.map((p) => p.day));
  const step = (points.length - 1) / (max - 1);
  return new Set(Array.from({ length: max }, (_, i) => points[Math.round(i * step)].day));
}

export default function AdminTrendChart({
  series,
  metric,
  height = 220,
}: {
  series: TrendPoint[];
  metric: TrendMetric;
  height?: number;
}) {
  const total = series.reduce((n, p) => n + (p[metric] ?? 0), 0);
  if (!series.length || total === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[12px] text-[var(--muted-2)]"
        style={{ height }}
      >
        No {LABELS[metric].toLowerCase()} in this window.
      </div>
    );
  }
  const shown = ticks(series);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="adminTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-views)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-views)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: "var(--muted-2)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            interval={0}
            tickFormatter={(d: string) => (shown.has(d) ? shortDay(d) : "")}
          />
          <YAxis tick={{ fill: "var(--muted-2)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 12,
              color: "var(--fg)",
            }}
            labelFormatter={(d) => shortDay(String(d))}
            formatter={(v) => [String(v), LABELS[metric]] as [string, string]}
          />
          <Area
            type="monotone"
            dataKey={metric}
            stroke="var(--chart-views)"
            strokeWidth={2}
            fill="url(#adminTrendFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
