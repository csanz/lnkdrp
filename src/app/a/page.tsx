/**
 * Admin home page: `/a`
 *
 * Landing page for admin tools and a cron health snapshot panel.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import { fmtDate, fmtDuration } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type CronHealthItem = {
  jobKey: string;
  status?: "ok" | "running" | "error" | null;
  lastRunAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
  lastResult?: unknown;
};
/**
 * Status Pill.
 */


function statusPill(status: CronHealthItem["status"]) {
  if (status === "running") return "bg-blue-100 text-blue-800";
  if (status === "error") return "bg-red-100 text-red-800";
  return "bg-emerald-100 text-emerald-800";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function formatStatsLine(item: CronHealthItem): string | null {
  if (!isPlainObject(item.lastResult)) return null;
  const r = item.lastResult;

  if (item.jobKey === "doc-metrics") {
    const processed = asFiniteNumber(r.processed);
    const days = asFiniteNumber(r.days);
    const views = asFiniteNumber(r.viewsLastDaysTotal);
    const downloads = asFiniteNumber(r.downloadsLastDaysTotal);
    const downloadsTotal = asFiniteNumber(r.downloadsTotalTotal);

    const parts: string[] = [];
    if (processed !== null) parts.push(`docs: ${processed}`);
    if (views !== null && days !== null) parts.push(`views (${days}d): ${views}`);
    else if (views !== null) parts.push(`views: ${views}`);
    if (downloads !== null && days !== null) parts.push(`downloads (${days}d): ${downloads}`);
    else if (downloads !== null) parts.push(`downloads: ${downloads}`);
    if (downloadsTotal !== null) parts.push(`downloads total: ${downloadsTotal}`);

    return parts.length ? `Stats: ${parts.join(" • ")}` : null;
  }

  const omitKeys = new Set(["docIds"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (omitKeys.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}: ${v}`);
    else if (typeof v === "boolean") parts.push(`${k}: ${v ? "true" : "false"}`);
    else if (typeof v === "string" && v.trim()) parts.push(`${k}: ${v.trim()}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? `Stats: ${parts.join(" • ")}` : null;
}
/**
 * Render the AdminHomePage UI (uses effects, memoized values, local state).
 */


export default function AdminHomePage() {
  const [health, setHealth] = useState<CronHealthItem[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(health) ? health : []), [health]);

  useEffect(() => {
    setHealthLoading(true);
    setHealthError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ items?: unknown }>("/api/admin/cron-health?limit=20", { method: "GET" });
        setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
      } catch (e) {
        setHealthError(e instanceof Error ? e.message : "Failed to load cron health");
        setHealth([]);
      } finally {
        setHealthLoading(false);
      }
    })();
  }, []);

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Choose an admin tool.</p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            href="/a/invitecodes"
            className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 transition hover:bg-[var(--panel-hover)]"
          >
            <div className="text-sm font-semibold text-[var(--fg)]">Invites</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Approve requests and manage codes.</div>
          </Link>

          <Link
            href="/a/shareviews"
            className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 transition hover:bg-[var(--panel-hover)]"
          >
            <div className="text-sm font-semibold text-[var(--fg)]">Share views</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Inspect recent share views.</div>
          </Link>

          <Link
            href="/a/ai-runs"
            className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 transition hover:bg-[var(--panel-hover)]"
          >
            <div className="text-sm font-semibold text-[var(--fg)]">AI runs</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Inspect prompts + outputs for AI features.</div>
          </Link>

          <Link
            href="/a/tools/billing"
            className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 transition hover:bg-[var(--panel-hover)]"
          >
            <div className="text-sm font-semibold text-[var(--fg)]">Billing tools</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Refresh Pro price label from Stripe (cached in Mongo).</div>
          </Link>
        </div>

        <div className="mt-8" id="cron-health">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--fg)]">Cron health</div>
              <div className="mt-1 text-sm text-[var(--muted)]">Latest heartbeat from background jobs.</div>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                // simple refresh
                setHealthLoading(true);
                setHealthError(null);
                void (async () => {
                  try {
                    const data = await fetchJson<{ items?: unknown }>("/api/admin/cron-health?limit=20", { method: "GET" });
                    setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
                    setHealthError(null);
                  } catch (e) {
                    setHealthError(e instanceof Error ? e.message : "Failed to load cron health");
                    setHealth([]);
                  } finally {
                    setHealthLoading(false);
                  }
                })();
              }}
            >
              Refresh
            </Button>
          </div>

          {healthError ? (
            <Alert variant="info" className="mt-4 border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
              {healthError}
            </Alert>
          ) : null}

          {healthLoading ? (
            <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
              Loading…
            </div>
          ) : normalized.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
              No health snapshots yet (cron may not have run).
            </div>
          ) : (
            <Panel padding="none" className="mt-4 overflow-hidden">
              <div className="divide-y divide-[var(--border)]">
                {normalized.map((item) => (
                  <div key={item.jobKey} className="px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-semibold text-[var(--fg)]">{item.jobKey}</div>
                          <span
                            className={[
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                              statusPill(item.status ?? "ok"),
                            ].join(" ")}
                          >
                            {item.status ?? "ok"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-[var(--muted-2)]">
                          Last run: {fmtDate(item.lastRunAt ?? null) || "—"}
                          {item.lastDurationMs ? ` • Duration: ${fmtDuration(item.lastDurationMs)}` : ""}
                        </div>
                        {(() => {
                          const stats = formatStatsLine(item);
                          return stats ? <div className="mt-1 text-xs text-[var(--muted-2)]">{stats}</div> : null;
                        })()}
                        {item.status === "error" && item.lastError ? (
                          <div className="mt-2 text-xs text-red-700">{item.lastError}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}


