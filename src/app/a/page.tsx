/**
 * Admin home page: `/a`
 *
 * Landing page for admin tools and a cron health snapshot panel.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type CronHealthItem = {
  jobKey: string;
  status?: "ok" | "running" | "error" | null;
  lastRunAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
};
/**
 * Fmt Date (uses isNaN, valueOf, toLocaleString).
 */


function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}
/**
 * Fmt Duration (uses isFinite, round, toFixed).
 */


function fmtDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${Math.round(r)}s`;
}
/**
 * Status Pill.
 */


function statusPill(status: CronHealthItem["status"]) {
  if (status === "running") return "bg-blue-100 text-blue-800";
  if (status === "error") return "bg-red-100 text-red-800";
  return "bg-emerald-100 text-emerald-800";
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
        const res = await fetch("/api/admin/cron-health?limit=20", { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; items?: unknown };
        if (!res.ok) {
          setHealthError(typeof data.error === "string" ? data.error : "Failed to load cron health");
          setHealth([]);
          return;
        }
        setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
      } catch {
        setHealthError("Failed to load cron health");
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
        </div>

        <div className="mt-8" id="cron-health">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--fg)]">Cron health</div>
              <div className="mt-1 text-sm text-[var(--muted)]">Latest heartbeat from background jobs.</div>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
              onClick={() => {
                // simple refresh
                setHealthLoading(true);
                setHealthError(null);
                void (async () => {
                  try {
                    const res = await fetch("/api/admin/cron-health?limit=20", { method: "GET" });
                    const data = (await res.json().catch(() => ({}))) as { error?: unknown; items?: unknown };
                    if (!res.ok) {
                      setHealthError(typeof data.error === "string" ? data.error : "Failed to load cron health");
                      setHealth([]);
                      return;
                    }
                    setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
                  } catch {
                    setHealthError("Failed to load cron health");
                    setHealth([]);
                  } finally {
                    setHealthLoading(false);
                  }
                })();
              }}
            >
              Refresh
            </button>
          </div>

          {healthError ? (
            <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
              {healthError}
            </div>
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
            <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
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
                        {item.status === "error" && item.lastError ? (
                          <div className="mt-2 text-xs text-red-700">{item.lastError}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


