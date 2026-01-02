/**
 * Admin route: `/a/shareviews/:docId`
 *
 * Shows all distinct share viewers for a specific document.
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

type ShareViewItem = {
  _id: string;
  shareId?: string | null;
  docId?: { _id?: string; title?: string | null; shareId?: string | null } | string | null;
  pagesSeen?: number[] | null;
  downloads?: number | null;
  downloadsByDay?: Record<string, number> | null;
  createdDate?: string | null;
  updatedDate?: string | null;
  viewerEmail?: string | null;
  viewerUserId?: { _id?: string; email?: string | null; name?: string | null } | string | null;
  viewerIp?: string | null;
};

type SeriesPoint = { key: string; label: string; value: number };
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
 * To Utc Day Key (uses slice, toISOString).
 */


function toUtcDayKey(d: Date) {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}
/**
 * Safe Date (uses isNaN, valueOf).
 */


function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return null;
  return d;
}
/**
 * Sum Downloads By Day (uses entries, Number, isFinite).
 */


function sumDownloadsByDay(items: ShareViewItem[]) {
  const out: Record<string, number> = {};
  for (const item of items) {
    const m = item.downloadsByDay ?? null;
    if (!m || typeof m !== "object") continue;
    for (const [k, raw] of Object.entries(m)) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}
/**
 * Build Daily Series From Items (uses UTC, getUTCFullYear, getUTCMonth).
 */


function buildDailySeriesFromItems(items: ShareViewItem[], days: number): SeriesPoint[] {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const counts: Record<string, number> = {};
  for (const item of items) {
    const d = safeDate(item.updatedDate ?? item.createdDate ?? null);
    if (!d) continue;
    const dayKey = toUtcDayKey(d);
    counts[dayKey] = (counts[dayKey] ?? 0) + 1;
  }

  const series: SeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = toUtcDayKey(d);
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    series.push({ key, label, value: counts[key] ?? 0 });
  }
  return series;
}
/**
 * Build Daily Series From Day Map (uses UTC, getUTCFullYear, getUTCMonth).
 */


function buildDailySeriesFromDayMap(dayMap: Record<string, number>, days: number): SeriesPoint[] {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const series: SeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = toUtcDayKey(d);
    const v = typeof dayMap[key] === "number" ? dayMap[key] : Number(dayMap[key] ?? 0);
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    series.push({ key, label, value: Number.isFinite(v) ? Math.max(0, v) : 0 });
  }
  return series;
}
/**
 * Viewer Label.
 */


function viewerLabel(item: ShareViewItem) {
  const email = item.viewerEmail ?? null;
  if (email) return email;
  const u = item.viewerUserId && typeof item.viewerUserId === "object" ? item.viewerUserId : null;
  if (u?.email) return u.email;
  if (u?.name) return u.name;
  return "anonymous";
}
/**
 * Doc Info (uses trim).
 */


function docInfo(item: ShareViewItem): { title: string; shareId: string | null } {
  if (item.docId && typeof item.docId === "object") {
    const title = typeof item.docId.title === "string" && item.docId.title.trim() ? item.docId.title : "(untitled)";
    const shareId = typeof item.docId.shareId === "string" ? item.docId.shareId : null;
    return { title, shareId };
  }
  return { title: "(unknown doc)", shareId: typeof item.shareId === "string" ? item.shareId : null };
}
/**
 * Render the StatCard UI.
 */


function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-[var(--fg)]">{value}</div>
      {sub ? <div className="mt-1 text-xs text-[var(--muted-2)]">{sub}</div> : null}
    </div>
  );
}
/**
 * Render the MiniBarSeries UI.
 */


function MiniBarSeries({
  title,
  subtitle,
  series,
  valueSuffix,
}: {
  title: string;
  subtitle?: string;
  series: SeriesPoint[];
  valueSuffix?: string;
}) {
  const max = series.reduce((m, p) => Math.max(m, p.value), 0);
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--fg)]">{title}</div>
          {subtitle ? <div className="mt-1 text-xs text-[var(--muted-2)]">{subtitle}</div> : null}
        </div>
        <div className="text-xs text-[var(--muted-2)]">
          Max: {max}
          {valueSuffix ?? ""}
        </div>
      </div>
      <div className="mt-4 flex h-16 items-end gap-[2px]">
        {series.map((p) => {
          const pct = max > 0 ? Math.round((p.value / max) * 100) : 0;
          const h = p.value > 0 ? Math.max(6, pct) : 2;
          return (
            <div
              key={p.key}
              className="flex-1 rounded-sm bg-[var(--primary-bg)]/70"
              style={{ height: `${h}%` }}
              title={`${p.label}: ${p.value}${valueSuffix ?? ""}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[var(--muted-2)]">
        <span>{series[0]?.label ?? ""}</span>
        <span>{series[Math.floor(series.length / 2)]?.label ?? ""}</span>
        <span>{series[series.length - 1]?.label ?? ""}</span>
      </div>
    </div>
  );
}
/**
 * Render the ShareViewsDocAdminPage UI (uses effects, memoized values, local state).
 */


export default function ShareViewsDocAdminPage({ params }: { params: { docId: string } }) {
  const docId = params.docId;
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [items, setItems] = useState<ShareViewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<7 | 14 | 30>(14);

  const normalized = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const header = useMemo(() => (normalized.length ? docInfo(normalized[0]) : null), [normalized]);

  const stats = useMemo(() => {
    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;
    const last24h = now - msDay;
    const last7d = now - 7 * msDay;

    let views24h = 0;
    let views7d = 0;
    let totalPagesSeen = 0;
    const pagesSeenCounts: Record<string, number> = {};
    let totalDownloads = 0;

    for (const item of normalized) {
      const d = safeDate(item.updatedDate ?? item.createdDate ?? null);
      const t = d?.valueOf() ?? null;
      if (typeof t === "number") {
        if (t >= last24h) views24h++;
        if (t >= last7d) views7d++;
      }

      const pages = Array.isArray(item.pagesSeen) ? item.pagesSeen.length : 0;
      totalPagesSeen += pages;
      const bucket =
        pages <= 0
          ? "0"
          : pages === 1
            ? "1"
            : pages <= 3
              ? "2-3"
              : pages <= 6
                ? "4-6"
                : pages <= 10
                  ? "7-10"
                  : "11+";
      pagesSeenCounts[bucket] = (pagesSeenCounts[bucket] ?? 0) + 1;

      const dl = typeof item.downloads === "number" ? item.downloads : Number(item.downloads ?? 0);
      if (Number.isFinite(dl) && dl > 0) totalDownloads += dl;
    }

    const avgPages = normalized.length ? totalPagesSeen / normalized.length : 0;

    const viewSeries = buildDailySeriesFromItems(normalized, rangeDays);
    const downloadsByDay = sumDownloadsByDay(normalized);
    const downloadSeries = buildDailySeriesFromDayMap(downloadsByDay, rangeDays);

    return {
      totalViews: normalized.length,
      views24h,
      views7d,
      avgPages,
      totalDownloads,
      pagesSeenCounts,
      viewSeries,
      downloadSeries,
    };
  }, [normalized, rangeDays]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!docId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/shareviews/doc/${encodeURIComponent(docId)}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; items?: unknown };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load share views");
          setItems([]);
          return;
        }
        setItems(Array.isArray(data.items) ? (data.items as ShareViewItem[]) : []);
      } catch {
        setError("Failed to load share views");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, docId]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Share views</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: `/a/shareviews/${encodeURIComponent(docId)}` })}
            >
              Sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Share views</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">
              Admin / Share views / {header?.title ?? "Document"}
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">All distinct viewers for this doc.</p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/a/shareviews"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
            >
              Back
            </Link>
            {header?.shareId ? (
              <a
                href={`/s/${encodeURIComponent(header.shareId)}`}
                className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
                target="_blank"
                rel="noreferrer"
              >
                Open share
              </a>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {normalized.length ? (
          <div className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--fg)]">Overview</div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted-2)]">Range</span>
                <select
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--fg)]"
                  value={rangeDays}
                  onChange={(e) => setRangeDays((Number(e.target.value) as 7 | 14 | 30) || 14)}
                >
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                </select>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Unique viewers" value={stats.totalViews} sub="Per (shareId, viewer) record" />
              <StatCard label="Views (24h / 7d)" value={`${stats.views24h} / ${stats.views7d}`} />
              <StatCard label="Avg pages seen" value={stats.avgPages.toFixed(1)} />
              <StatCard
                label="Downloads (total)"
                value={stats.totalDownloads}
                sub="Best-effort count from /s/:shareId/pdf?download=1"
              />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <MiniBarSeries title="Views by day" subtitle={`Last-seen activity (UTC), last ${rangeDays} days`} series={stats.viewSeries} />
              <MiniBarSeries title="Downloads by day" subtitle={`UTC, last ${rangeDays} days`} series={stats.downloadSeries} />
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4">
                <div className="text-sm font-semibold text-[var(--fg)]">Pages seen (distribution)</div>
                <div className="mt-1 text-xs text-[var(--muted-2)]">Per viewer record</div>
                <div className="mt-4 space-y-2">
                  {(["0", "1", "2-3", "4-6", "7-10", "11+"] as const).map((k) => {
                    const v = stats.pagesSeenCounts[k] ?? 0;
                    const max = Math.max(...Object.values(stats.pagesSeenCounts), 1);
                    const pct = Math.round((v / max) * 100);
                    return (
                      <div key={k} className="flex items-center gap-3">
                        <div className="w-12 text-xs text-[var(--muted-2)]">{k}</div>
                        <div className="h-2 flex-1 rounded-full bg-[var(--panel-2)]">
                          <div className="h-2 rounded-full bg-[var(--primary-bg)]/70" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="w-10 text-right text-xs text-[var(--muted-2)]">{v}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : normalized.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            No views for this doc yet.
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {normalized.map((v) => {
              const viewedAt = fmtDate(v.updatedDate ?? v.createdDate ?? null);
              const pages = Array.isArray(v.pagesSeen) ? v.pagesSeen.length : 0;
              const viewer = viewerLabel(v);
              return (
                <div
                  key={v._id}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--fg)]">{viewer}</div>
                      <div className="mt-1 text-xs text-[var(--muted-2)]">
                        Last seen: {viewedAt} • Pages seen: {pages}
                      </div>
                      {v.viewerIp ? (
                        <div className="mt-1 text-xs text-[var(--muted-2)]">IP: {v.viewerIp}</div>
                      ) : null}
                    </div>
                    {v.shareId ? (
                      <a
                        href={`/s/${encodeURIComponent(v.shareId)}`}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open share
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


