"use client";

/**
 * Charged revenue by day on the admin home: credit packs and on-demand usage, stacked.
 *
 * A smooth area with value labels, like every other chart in the app — never bars. Subscription
 * run-rate is deliberately not plotted: nothing is charged on a given day by a subscription, and
 * drawing MRR as a flat band across the window would read as daily income. It sits in a tile instead.
 */
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { fmtMoney, type RevenueDay } from "@/lib/admin/revenue";

const PACK_COLOR = "var(--chart-views)";
const ON_DEMAND_COLOR = "color-mix(in srgb, var(--chart-views) 45%, var(--panel))";

/** At most seven dates under the plot, evenly picked, so 90 days stays readable. */
function tickDays(days: RevenueDay[], max = 7): string[] {
  if (days.length <= max) return days.map((d) => d.day);
  const step = (days.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => days[Math.round(i * step)].day);
}

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : day;
}

export default function RevenueChart({ series, height = 200 }: { series: RevenueDay[]; height?: number }) {
  const total = series.reduce((n, d) => n + d.packCents + d.onDemandCents, 0);
  if (!series.length || total === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[12px] text-[var(--muted-2)]"
        style={{ height }}
      >
        No credit packs bought and no on-demand usage in this window.
      </div>
    );
  }

  const ticks = new Set(tickDays(series));
  return (
    <div style={{ height }} className="w-full">
      <AreaChart
        width={900}
        height={height}
        data={series}
        margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
        style={{ width: "100%" }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fill: "var(--muted-2)", fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tickFormatter={(d: string) => (ticks.has(d) ? shortDay(d) : "")}
          interval={0}
          minTickGap={0}
        />
        <YAxis
          tick={{ fill: "var(--muted-2)", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => fmtMoney(v)}
        />
        <Tooltip
          contentStyle={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--fg)",
          }}
          labelFormatter={(d) => shortDay(String(d))}
          formatter={(value, name) => [fmtMoney(typeof value === "number" ? value : 0), name === "packCents" ? "Credit packs" : "On-demand"] as [string, string]}
        />
        <Area
          type="monotone"
          dataKey="packCents"
          name="packCents"
          stackId="revenue"
          stroke={PACK_COLOR}
          fill={PACK_COLOR}
          fillOpacity={0.22}
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="onDemandCents"
          name="onDemandCents"
          stackId="revenue"
          stroke={ON_DEMAND_COLOR}
          fill={ON_DEMAND_COLOR}
          fillOpacity={0.3}
          strokeWidth={2}
        />
      </AreaChart>
    </div>
  );
}
