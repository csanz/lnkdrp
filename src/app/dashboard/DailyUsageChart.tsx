/**
 * Daily usage chart for `/dashboard?tab=usage`.
 *
 * Cursor-style: show daily bars by model route with a metric toggle (Credits / Spend) and a cumulative option.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import Alert from "@/components/ui/Alert";
import { cn } from "@/lib/cn";
import { formatUsdFromCents } from "@/lib/format/money";
import { CREDITS_SNAPSHOT_REFRESH_EVENT } from "@/lib/client/creditsSnapshotRefresh";
import type { DailyUsageChartRow } from "./DailyUsageChartRenderer";
import DailyUsageChartRenderer from "./DailyUsageChartRenderer";

type UsageDailyResponse = {
  ok: true;
  days: 1 | 7 | 30;
  canViewSpend: boolean;
  models: Array<{ key: string; label: string }>;
  series: Array<{
    day: string;
    totalCredits: number;
    totalSpendCents: number;
    byModel: Record<string, { credits: number; spendCents: number }>;
  }>;
};

type Metric = "credits" | "spend";
type Grouping = "model" | "total";

const COLORS = [
  "rgb(148 163 184)", // slate
  "rgb(56 189 248)", // sky
  "rgb(16 185 129)", // emerald
  "rgb(168 85 247)", // violet
  "rgb(251 146 60)", // orange
  "rgb(34 197 94)", // green
  "rgb(203 213 225)", // slate light
];

function niceNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return n;
}

function fmtAxis(metric: Metric, v: any): string {
  const n = niceNumber(v);
  if (metric === "spend") return `$${n.toFixed(n >= 10 ? 0 : 2)}`;
  return Math.round(n).toLocaleString();
}

function fmtTooltip(metric: Metric, v: any): string {
  const n = niceNumber(v);
  if (metric === "spend") return formatUsdFromCents(Math.round(n * 100));
  return Math.round(n).toLocaleString();
}

// Small in-memory cache: makes tab switching feel instant and avoids re-fetching if the user
// toggles between Usage/Overview quickly. This does not change server cache semantics.
const USAGE_DAILY_CACHE_TTL_MS = 30_000;
let usageDailyCache: Map<number, { at: number; resp: UsageDailyResponse }> | null = null;

export default function DailyUsageChart({
  className,
  days,
}: {
  className?: string;
  days: 1 | 7 | 30;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<UsageDailyResponse | null>(() => {
    const cached = usageDailyCache?.get?.(days);
    if (!cached) return null;
    if (Date.now() - cached.at > USAGE_DAILY_CACHE_TTL_MS) return null;
    return cached.resp;
  });
  const [metric, setMetric] = useState<Metric>("credits");
  const [group, setGroup] = useState<Grouping>("model");
  const [cumulative, setCumulative] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const onRefresh = () => setRefreshNonce((v) => v + 1);
    window.addEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
  }, []);

  // Make spend feel like the Cursor screenshot (cumulative by default).
  useEffect(() => {
    if (metric === "spend") setCumulative(true);
  }, [metric]);

  useEffect(() => {
    let cancelled = false;
    const cached = usageDailyCache?.get?.(days);
    const cachedFresh = Boolean(cached) && Date.now() - (cached?.at ?? 0) < USAGE_DAILY_CACHE_TTL_MS;
    // If cached data exists, avoid a visible "Loading…" state.
    setBusy(!cachedFresh && !resp);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("days", String(days));
        const res = await fetch(`/api/dashboard/usage-daily?${qs.toString()}`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as UsageDailyResponse | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || (json as any).ok !== true) throw new Error("Invalid response");
        if (!cancelled) setResp(json as UsageDailyResponse);
        usageDailyCache = usageDailyCache ?? new Map();
        usageDailyCache.set(days, { at: Date.now(), resp: json as UsageDailyResponse });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load daily usage";
        if (!cancelled) setError(msg);
        // Keep cached data visible if we have it (avoid turning a transient failure into a blank chart).
        if (!cancelled && !(usageDailyCache?.get?.(days)?.resp)) setResp(null);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, refreshNonce]);

  const models = Array.isArray(resp?.models) ? resp!.models : [];
  const series = Array.isArray(resp?.series) ? resp!.series : [];
  const canViewSpend = Boolean(resp?.canViewSpend);

  const keys = useMemo(() => {
    if (group === "total") return [{ key: "total", label: "total" }];
    return models.length ? models : [{ key: "m0", label: "default" }];
  }, [group, models]);

  const chartData = useMemo(() => {
    const rows = series.map((s) => {
      const row: Record<string, any> = { day: s.day };
      if (group === "total") {
        row.total = metric === "credits" ? s.totalCredits : s.totalSpendCents / 100;
      } else {
        for (const k of keys) {
          const cell = s.byModel?.[k.key];
          row[k.key] = metric === "credits" ? (cell?.credits ?? 0) : (cell?.spendCents ?? 0) / 100;
        }
      }
      return row;
    });

    if (!cumulative) return rows;
    const running: Record<string, number> = {};
    return rows.map((r) => {
      const next = { ...r };
      for (const k of keys) {
        const v = niceNumber(r[k.key]);
        running[k.key] = (running[k.key] ?? 0) + v;
        next[k.key] = running[k.key];
      }
      if (group === "total") {
        const v = niceNumber(r.total);
        running.total = (running.total ?? 0) + v;
        next.total = running.total;
      }
      return next;
    });
  }, [series, group, keys, metric, cumulative]);

  const max = useMemo(() => {
    let m = 0;
    for (const r of chartData) {
      for (const k of keys) m = Math.max(m, niceNumber(r[k.key]));
      if (group === "total") m = Math.max(m, niceNumber(r.total));
    }
    return Math.max(1, m);
  }, [chartData, group, keys]);

  return (
    <div className={cn("rounded-2xl bg-[var(--panel)] p-6", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Daily usage</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Usage per day across your selected range.</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1">
            {(["model", "total"] as const).map((g) => {
              const active = group === g;
              const label = g === "model" ? "By model" : "Total";
              return (
                <button
                  key={g}
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-1.5 text-[12px] font-semibold",
                    active ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                  )}
                  onClick={() => setGroup(g)}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1">
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-semibold",
                metric === "credits" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
              )}
              onClick={() => setMetric("credits")}
            >
              Credits
            </button>
            <button
              type="button"
              disabled={!canViewSpend}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-semibold",
                metric === "spend" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                !canViewSpend ? "opacity-50" : null,
              )}
              title={!canViewSpend ? "Spend is only available to workspace owners/admins." : undefined}
              onClick={() => setMetric("spend")}
            >
              Spend
            </button>
          </div>

          <label className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--muted-2)]">
            <input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} />
            Cumulative
          </label>
        </div>
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
        {busy ? (
          <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
        ) : !chartData.length ? (
          <div className="px-2 py-2 text-[12px] text-[var(--muted-2)]">No data yet.</div>
        ) : (
          <div className="w-full">
            {group === "model" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 pb-2 text-[11px] text-[var(--muted-2)]">
                {keys.map((k, i) => (
                  <div key={k.key} className="inline-flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: COLORS[i % COLORS.length] }}
                      aria-hidden="true"
                    />
                    <span>{k.label}</span>
                  </div>
                ))}
                <div className="ml-auto text-[11px] text-[var(--muted-2)]">Max: {metric === "spend" ? fmtAxis(metric, max) : fmtAxis(metric, max)}</div>
              </div>
            ) : (
              <div className="flex items-center justify-end px-1 pb-2 text-[11px] text-[var(--muted-2)]">Max: {fmtAxis(metric, max)}</div>
            )}

            <DailyUsageChartRenderer
              chartData={chartData as DailyUsageChartRow[]}
              group={group}
              keys={keys}
              metric={metric}
              max={max}
              colors={COLORS}
            />
          </div>
        )}
      </div>
    </div>
  );
}


