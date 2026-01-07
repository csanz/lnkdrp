"use client";

import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsdFromCents } from "@/lib/format/money";

export type DailyUsageChartRow = Record<string, any> & { day: string };

function niceNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return n;
}

export default function DailyUsageChartRenderer({
  chartData,
  group,
  keys,
  metric,
  max,
  colors,
}: {
  chartData: DailyUsageChartRow[];
  group: "model" | "total";
  keys: Array<{ key: string; label: string }>;
  metric: "credits" | "spend";
  max: number;
  colors: string[];
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const xLabels = chartData.map((d) => String(d.day));
  const left = xLabels[0] ?? "";
  const mid = xLabels[Math.floor(xLabels.length / 2)] ?? "";
  const right = xLabels[xLabels.length - 1] ?? "";

  function fmtAxis(v: any): string {
    const n = niceNumber(v);
    if (metric === "spend") return `$${n.toFixed(n >= 10 ? 0 : 2)}`;
    return Math.round(n).toLocaleString();
  }

  function fmtTooltip(v: any): string {
    const n = niceNumber(v);
    if (metric === "spend") return formatUsdFromCents(Math.round(n * 100));
    return Math.round(n).toLocaleString();
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    function update() {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w > 0 && h > 0) setSize({ w, h });
    }

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="h-56 w-full">
      {!size ? null : (
        <BarChart width={size.w} height={size.h} data={chartData} margin={{ top: 6, right: 10, bottom: 6, left: 6 }}>
          <CartesianGrid stroke="var(--border)" strokeOpacity={0.16} vertical={false} />
          <XAxis
            dataKey="day"
            ticks={[left, mid, right].filter(Boolean)}
            tick={{ fontSize: 10, fill: "var(--muted-2)" }}
            axisLine={false}
            tickLine={false}
            interval={0}
            height={24}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--muted-2)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => fmtAxis(v)}
            domain={[0, "dataMax"]}
          />
          <Tooltip
            cursor={{ fill: "var(--panel-hover)", fillOpacity: 0.5 }}
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "8px 10px",
              fontSize: 12,
              color: "var(--fg)",
            }}
            labelStyle={{ color: "var(--muted-2)" }}
            formatter={(v: any, name: any) => [fmtTooltip(v), String(name ?? "")]}
          />

          {group === "total" ? (
            <Bar
              dataKey="total"
              name={metric === "spend" ? "Spend" : "Credits"}
              fill="rgb(56 189 248)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          ) : (
            keys.map((k, i) => (
              <Bar
                key={k.key}
                dataKey={k.key}
                name={k.label}
                stackId="a"
                fill={colors[i % colors.length]}
                radius={i === keys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                isAnimationActive={false}
              />
            ))
          )}
        </BarChart>
      )}
    </div>
  );
}


