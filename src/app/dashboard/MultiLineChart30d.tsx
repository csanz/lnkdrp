/**
 * Client-only chart component for the Dashboard Overview tab.
 *
 * Kept in a separate file so it can be code-split (Recharts is large).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

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

  const lines: Array<{ key: string; label: string; stroke: string }> = [
    { key: "uploads", label: "Uploads", stroke: "rgb(59 130 246)" },
    { key: "docs", label: "Docs created", stroke: "rgb(16 185 129)" },
    { key: "views", label: "Unique share views", stroke: "rgb(168 85 247)" },
    { key: "downloads", label: "Share downloads", stroke: "rgb(34 197 94)" },
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
          <LineChart width={size.w} height={size.h} data={data} margin={{ top: 6, right: 10, bottom: 6, left: 6 }}>
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
            <YAxis hide domain={[0, "dataMax"]} />
            <Tooltip
              cursor={{ stroke: "var(--border)", strokeOpacity: 0.25 }}
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
            <Line type="monotone" dataKey="uploads" stroke="rgb(59 130 246)" strokeWidth={1.1} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="docs" stroke="rgb(16 185 129)" strokeWidth={1.1} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="views" stroke="rgb(168 85 247)" strokeWidth={1.1} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="downloads" stroke="rgb(34 197 94)" strokeWidth={1.1} dot={false} isAnimationActive={false} />
          </LineChart>
        )}
      </div>
    </div>
  );
}

