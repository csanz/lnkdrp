/**
 * Admin route: `/a/cron-health`
 *
 * Shows the latest cron health/heartbeat snapshots written by cron endpoints.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { fmtDate, fmtDuration } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type CronHealthItem = {
  jobKey: string;
  status?: "ok" | "running" | "error" | null;
  lastRunAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
};
/**
 * Status Pill.
 */


function statusPill(status: CronHealthItem["status"]) {
  if (status === "running") return "bg-blue-100 text-blue-800";
  if (status === "error") return "bg-red-100 text-red-800";
  return "bg-emerald-100 text-emerald-800";
}
/**
 * Render the CronHealthAdminPage UI (uses effects, memoized values, local state).
 */


export default function CronHealthAdminPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [health, setHealth] = useState<CronHealthItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(health) ? health : []), [health]);
/**
 * Load (updates state (setLoading, setError, setHealth); uses setLoading, setError, fetch).
 */


  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ items?: unknown }>("/api/admin/cron-health?limit=50", { method: "GET" });
      setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cron health");
      setHealth([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canUseAdmin) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseAdmin]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Cron health</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/cron-health" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Cron health</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Cron health</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Latest heartbeat snapshots from cron jobs.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/a"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
            >
              Admin home
            </Link>
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : normalized.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            No health snapshots yet (cron may not have run).
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <div className="divide-y divide-[var(--border)]">
              {normalized.map((item) => (
                <div key={item.jobKey} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
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
  );
}




