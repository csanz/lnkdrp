/**
 * Client-only chart component for the Dashboard Overview tab.
 *
 * Kept in a separate file so it can be code-split (Recharts is large).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, LabelList, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { valueLabels } from "@/components/charts/ChartValueLabel";

export default function MultiLineChart30d({
  series,
}: {
  series: Array<{ day: string; docsCreated: number; uploadsCreated: number; shareUniqueViews: number; shareDownloads: number }>;
}) {
  const safe = Array.isArray(series) ? series : [];
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const data = safe.map((s) => ({
    day: s.day,
    uploads: typeof s.uploadsCreated === "number" && Number.isFinite(s.uploadsCreated) ? Math.max(0, s.uploadsCreated) : 0,
    docs: typeof s.docsCreated === "number" && Number.isFinite(s.docsCreated) ? Math.max(0, s.docsCreated) : 0,
    views: typeof s.shareUniqueViews === "number" && Number.isFinite(s.shareUniqueViews) ? Math.max(0, s.shareUniqueViews) : 0,
    downloads: typeof s.shareDownloads === "number" && Number.isFinite(s.shareDownloads) ? Math.max(0, s.shareDownloads) : 0,
  }));

  /* The four series used to be raw 500-level hues, picked on the dark panel: on a white one they
     ran 2.3-4.0:1, and emerald-500 / green-500 were near-identical for two different series.
     `--chart-work-*` is the app's categorical ramp and already has a validated value per theme. */
  const lines: Array<{ key: string; label: string; stroke: string }> = [
    { key: "uploads", label: "Uploads", stroke: "var(--chart-work-2)" },
    { key: "docs", label: "Docs created", stroke: "var(--chart-views)" },
    { key: "views", label: "Unique share views", stroke: "var(--chart-work-5)" },
    { key: "downloads", label: "Share downloads", stroke: "var(--chart-downloads)" },
  ];

  const labels = data.map((d) => d.day);
  const left = labels[0] ?? "";
  const mid = labels[Math.floor(labels.length / 2)] ?? "";
  const right = labels[labels.length - 1] ?? "";

  const max = Math.max(1, ...data.map((d) => Math.max(d.uploads, d.docs, d.views, d.downloads)));

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    function update(target: HTMLDivElement) {
      const r = target.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w > 0 && h > 0) setSize({ w, h });
    }

    update(el);
    const ro = new ResizeObserver(() => update(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 pb-2 text-[11px] text-[var(--muted-2)]">
        {lines.map((l) => (
          <div key={l.key} className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: l.stroke }} aria-hidden="true" />
            <span>{l.label}</span>
          </div>
        ))}
        <div className="ml-auto text-[11px] text-[var(--muted-2)]">Max: {max.toLocaleString()}</div>
      </div>

      <div ref={wrapRef} className="h-56 w-full">
        {!size ? null : (
          <LineChart width={size.w} height={size.h} data={data} margin={{ top: 18, right: 30, bottom: 6, left: 30 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="day"
              ticks={[left, mid, right].filter(Boolean)}
              tick={{ fontSize: 10, fill: "var(--muted-2)" }}
              axisLine={false}
              tickLine={false}
              interval={0}
              height={24}
            />
            <YAxis hide domain={[0, "dataMax"]} />
            <Tooltip
              cursor={{ stroke: "var(--chart-cursor)" }}
              contentStyle={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "8px 10px",
                fontSize: 12,
                color: "var(--fg)",
              }}
              labelStyle={{ color: "var(--muted-2)" }}
              formatter={(v: any, name: any) => [
                typeof v === "number" ? v.toLocaleString() : String(v),
                String(name ?? ""),
              ]}
            />
            {/* Four series over 30 days: label only each line's highest day, or the numbers from
                four lines pile into each other. The label takes `--muted` (ChartValueLabel's
                default), not the line's colour: a 10px label in a series hue is text held to a
                3:1 stroke standard, which is under AA wherever the ground is pale. */}
            {lines.map((l) => (
              <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.stroke} strokeWidth={1.1} dot={false} isAnimationActive={false}>
                <LabelList
                  dataKey={l.key}
                  content={valueLabels({ values: data.map((d) => Number((d as Record<string, unknown>)[l.key]) || 0), mode: "max" })}
                />
              </Line>
            ))}
          </LineChart>
        )}
      </div>
    </div>
  );
}

