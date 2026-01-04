"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/modals/Modal";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, YAxis } from "recharts";

type MetricsResponse = {
  ok: true;
  days: number;
  totals: { views: number; downloads: number; pagesViewed: number; authenticatedViewers: number };
  downloadsEnabled?: boolean;
  series: Array<{ date: string; views: number; downloads: number }>;
  viewers: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    views: number;
    firstSeen: string | null;
    lastSeen: string | null;
  }>;
};
/**
 * Format Date Time (uses isFinite, getTime, format).
 */


function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}
/**
 * Format Day Label (uses isFinite, getTime, format).
 */


function formatDayLabel(isoDay: string | null): string {
  if (!isoDay) return "";
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return isoDay;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}
/**
 * Render the MiniLineChartSingle UI.
 */


function MiniLineChartSingle({
  series,
  values,
  stroke,
  fillId,
  fillStops,
}: {
  series: Array<{ date: string }>;
  values: number[];
  stroke: string;
  fillId: string;
  fillStops: { topOpacity: number; bottomOpacity: number };
}) {
  const safeValues = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0));
  const data = series.map((s, idx) => ({ date: s.date, value: safeValues[idx] ?? 0 }));

  return (
    <div className="w-full">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 4, left: 6 }}>
            <defs>
              <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={fillStops.topOpacity} />
                <stop offset="100%" stopColor={stroke} stopOpacity={fillStops.bottomOpacity} />
              </linearGradient>
            </defs>

            <YAxis hide domain={[0, "dataMax"]} />
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.18} vertical={false} />
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
              formatter={(v: any) => [typeof v === "number" ? v.toLocaleString() : String(v), ""]}
              labelFormatter={(label: any) => String(label ?? "")}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={stroke}
              strokeWidth={1.15}
              fill={`url(#${fillId})`}
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 2.25, strokeWidth: 1.15 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div
        className="mt-3 grid gap-0 text-[10px] text-[var(--muted)]"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, series.length)}, minmax(0, 1fr))` }}
      >
        {series.map((s) => (
          <div key={`tick:${s.date}`} className="px-1 text-center tabular-nums">
            {formatDayLabel(s.date)}
          </div>
        ))}
      </div>
    </div>
  );
}
/**
 * Render the DocMetricsModal UI (uses effects, memoized values, local state).
 */


export default function DocMetricsModal({
  open: openProp,
  onClose,
  docId,
  embedded,
}: {
  open?: boolean;
  onClose?: () => void;
  docId: string;
  embedded?: boolean;
}) {
  const isEmbedded = Boolean(embedded);
  const open = isEmbedded ? (openProp ?? true) : Boolean(openProp);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MetricsResponse | null>(null);

  const [days, setDays] = useState(15);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeLabel = useMemo(() => `Last ${days} days`, [days]);

  useEffect(() => {
    if (!open) return;
/**
 * Handle pointer down events; updates state (setRangeOpen); uses contains, setRangeOpen.
 */

    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setRangeOpen(false);
    }
/**
 * Handle key down events; updates state (setRangeOpen); uses setRangeOpen.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setRangeOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
/**
 * Load (updates state (setLoading, setError, setData); uses setLoading, setError, fetchWithTempUser).
 */

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Request failed (${res.status})`);
        }
        const json = (await res.json()) as unknown;
        if (cancelled) return;
        if (!json || typeof json !== "object" || !(json as { ok?: unknown }).ok) {
          throw new Error("Invalid response");
        }
        setData(json as MetricsResponse);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load metrics");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, docId, days]);

  const views = data?.totals?.views ?? 0;
  const downloads = data?.totals?.downloads ?? 0;
  const pagesViewed = data?.totals?.pagesViewed ?? 0;
  const authedViewers = data?.totals?.authenticatedViewers ?? 0;
  const downloadsEnabled = Boolean(data?.downloadsEnabled);
  const series = Array.isArray(data?.series) ? data!.series : [];
  const hasData = Boolean(data && data.ok);
  const chartSeries = series.map((s) => ({ date: s.date }));
  const viewsSeries = series.map((s) => (typeof s.views === "number" && Number.isFinite(s.views) ? s.views : 0));
  const downloadsSeries = series.map((s) =>
    typeof s.downloads === "number" && Number.isFinite(s.downloads) ? s.downloads : 0,
  );

  const dateRangeLabel = useMemo(() => {
    if (!series.length) return `Last ${days} days`;
    const first = series[0]?.date ?? "";
    const last = series[series.length - 1]?.date ?? "";
    return first && last ? `${first} → ${last}` : `Last ${days} days`;
  }, [series]);

  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-base font-semibold text-[var(--fg)]">Metrics</div>
          <div className="mt-1 text-sm text-[var(--muted)]">{dateRangeLabel}</div>
        </div>

        <div ref={rootRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setRangeOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
            aria-label="Select date range"
            title="Select date range"
          >
            {rangeLabel}
            <ChevronDown />
          </button>

          {rangeOpen ? (
            <div className="absolute right-0 top-[calc(100%+8px)] z-10 w-56 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl ring-1 ring-black/5">
              <div className="p-2">
                {[
                  { label: "Last 3 days", value: 3 },
                  { label: "Last 7 days", value: 7 },
                  { label: "Last 15 days", value: 15 },
                  { label: "Last 30 days", value: 30 },
                ].map((opt) => {
                  const active = opt.value === days;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setDays(opt.value);
                        setRangeOpen(false);
                      }}
                      className={[
                        "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm",
                        active
                          ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                          : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
                      ].join(" ")}
                    >
                      <span>{opt.label}</span>
                      {active ? <Check /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Views card */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
            <div className="min-w-0">
              <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">VIEWS</div>

              {loading ? (
                <div className="mt-1 h-9 w-16 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
              ) : error ? (
                <div className="mt-1 text-sm text-red-700">{error}</div>
              ) : (
                <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">{views}</div>
              )}

              <div className="mt-2 text-sm text-[var(--muted)]">
                {loading ? (
                  <div className="h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                ) : (
                  <>
                    <span className="tabular-nums">{pagesViewed}</span> pages viewed ·{" "}
                    <span className="tabular-nums">{authedViewers}</span> authenticated viewers
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Downloads card */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
            <div className="min-w-0">
              <div className="text-xs font-semibold tracking-wide text-[var(--muted-2)]">DOWNLOADS</div>

              {loading ? (
                <div className="mt-1 h-9 w-20 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
              ) : error ? (
                <div className="mt-1 text-sm text-red-700">{error}</div>
              ) : downloadsEnabled ? (
                <div className="mt-1 text-3xl font-semibold text-[var(--fg)] tabular-nums">{downloads}</div>
              ) : (
                <div className="mt-2 text-sm font-semibold text-[var(--muted)]">Not enabled</div>
              )}

              <div className="mt-2 text-sm text-[var(--muted)]">
                {loading ? (
                  <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                ) : downloadsEnabled ? (
                  <span className="text-[var(--muted)]">PDF downloads</span>
                ) : (
                  <span className="text-[var(--muted)]">PDF download is disabled for this share link.</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Two separate charts (Views + Downloads) */}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
            <div className="text-sm font-semibold text-[var(--fg)]">Views</div>
            <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              {loading ? (
                <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
              ) : (
                <MiniLineChartSingle
                  series={chartSeries}
                  values={viewsSeries}
                  stroke="rgb(16 185 129)"
                  fillId="lnkdrpMetricsFillViews"
                  fillStops={{ topOpacity: 0.22, bottomOpacity: 0 }}
                />
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--fg)]">Downloads</div>
              {!loading && !downloadsEnabled ? (
                <div className="text-xs font-medium text-[var(--muted)]">Not enabled</div>
              ) : null}
            </div>
            <div className="mt-3 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              {loading ? (
                <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
              ) : (
                <MiniLineChartSingle
                  series={chartSeries}
                  values={downloadsSeries}
                  stroke="rgb(34 197 94)"
                  fillId="lnkdrpMetricsFillDownloads"
                  fillStops={{ topOpacity: 0.18, bottomOpacity: 0 }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="text-sm font-semibold text-[var(--fg)]">Authenticated viewers</div>
        <div className="mt-1 text-sm text-[var(--muted)]">Only signed-in viewers are listed here.</div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
          <div className="min-h-[160px]">
            {loading ? (
              <div className="p-4">
                <div className="h-4 w-56 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                <div className="mt-3 h-4 w-72 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                <div className="mt-3 h-4 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
              </div>
            ) : error ? (
              <div className="p-4 text-sm text-red-700">{error}</div>
            ) : !hasData || !data?.viewers?.length ? (
              <div className="p-4 text-sm text-[var(--muted)]">No authenticated viewers yet.</div>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {data.viewers.map((v) => (
                  <li key={v.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--fg)]">
                        {v.name || v.email || v.userId}
                      </div>
                      {v.email ? <div className="truncate text-xs text-[var(--muted-2)]">{v.email}</div> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-medium text-[var(--muted-2)] tabular-nums">{v.views} views</div>
                      <div className="mt-0.5 text-xs text-[var(--muted)]">Last seen {formatDateTime(v.lastSeen)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );

  if (isEmbedded) {
    return <div className="w-full">{content}</div>;
  }

  return (
    <Modal
      open={open}
      onClose={onClose ?? (() => void 0)}
      ariaLabel="Metrics"
      panelClassName="w-[min(860px,calc(100vw-32px))]"
      // Reserve space so the modal doesn't "jump" as data loads.
      contentClassName="min-h-[520px]"
    >
      {content}
    </Modal>
  );
}
/**
 * Render the ChevronDown UI.
 */


function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="text-[var(--muted-2)]">
      <path
        d="M6 8l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/**
 * Render the Check UI.
 */


function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="text-[var(--muted-2)]">
      <path
        d="M16 6l-7 8-3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


