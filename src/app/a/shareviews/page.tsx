/**
 * Admin route: `/a/shareviews`
 *
 * Shows recent share views (deduped by viewer) for debugging/ops.
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type RecentShareViewItem = {
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


function sumDownloadsByDay(items: RecentShareViewItem[]) {
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


function buildDailySeriesFromItems(items: RecentShareViewItem[], days: number): SeriesPoint[] {
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
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const v = typeof dayMap[key] === "number" ? dayMap[key] : Number(dayMap[key] ?? 0);
    series.push({ key, label, value: Number.isFinite(v) ? Math.max(0, v) : 0 });
  }
  return series;
}
/**
 * Viewer Label.
 */


function viewerLabel(item: RecentShareViewItem) {
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


function docInfo(item: RecentShareViewItem): { docId: string | null; title: string; shareId: string | null } {
  if (item.docId && typeof item.docId === "object") {
    const id = typeof item.docId._id === "string" ? item.docId._id : null;
    const title = typeof item.docId.title === "string" && item.docId.title.trim() ? item.docId.title : "(untitled)";
    const shareId = typeof item.docId.shareId === "string" ? item.docId.shareId : null;
    return { docId: id, title, shareId };
  }
  return { docId: null, title: "(unknown doc)", shareId: typeof item.shareId === "string" ? item.shareId : null };
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
 * Render the ShareViewsAdminPage UI (uses effects, memoized values, local state).
 */


export default function ShareViewsAdminPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [items, setItems] = useState<RecentShareViewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<7 | 14 | 30>(14);

  const normalized = useMemo(() => (Array.isArray(items) ? items : []), [items]);

  const stats = useMemo(() => {
    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;
    const last24h = now - msDay;
    const last7d = now - 7 * msDay;

    let views24h = 0;
    let views7d = 0;
    const docCounts = new Map<string, { docId: string; title: string; shareId: string | null; count: number }>();
    const pagesSeenCounts: Record<string, number> = {};
    let totalPagesSeen = 0;
    let totalDownloads = 0;

    for (const item of normalized) {
      const d = safeDate(item.updatedDate ?? item.createdDate ?? null);
      const t = d?.valueOf() ?? null;
      if (typeof t === "number") {
        if (t >= last24h) views24h++;
        if (t >= last7d) views7d++;
      }

      const { docId, title, shareId } = docInfo(item);
      if (docId) {
        const prev = docCounts.get(docId);
        if (prev) prev.count += 1;
        else docCounts.set(docId, { docId, title, shareId, count: 1 });
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

    const topDocs = Array.from(docCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const avgPages = normalized.length ? totalPagesSeen / normalized.length : 0;

    const viewSeries = buildDailySeriesFromItems(normalized, rangeDays);
    const downloadsByDay = sumDownloadsByDay(normalized);
    const downloadSeries = buildDailySeriesFromDayMap(downloadsByDay, rangeDays);

    return {
      totalViews: normalized.length,
      views24h,
      views7d,
      docCount: docCounts.size,
      avgPages,
      totalDownloads,
      pagesSeenCounts,
      topDocs,
      viewSeries,
      downloadSeries,
    };
  }, [normalized, rangeDays]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ items?: unknown }>("/api/admin/shareviews/recent?limit=200", { method: "GET" });
        setItems(Array.isArray(data.items) ? (data.items as RecentShareViewItem[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share views");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin]);

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
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/shareviews" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Share views</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Share views</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Most recent share views (deduped by viewer).</p>
        </div>

        {normalized.length ? (
          <div className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--fg)]">Overview</div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted-2)]">Range</span>
                <Select
                  value={rangeDays}
                  onChange={(e) => setRangeDays((Number(e.target.value) as 7 | 14 | 30) || 14)}
                >
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                </Select>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Unique viewers (rows)" value={stats.totalViews} sub="Per (shareId, viewer) record" />
              <StatCard label="Docs touched" value={stats.docCount} />
              <StatCard label="Views (24h / 7d)" value={`${stats.views24h} / ${stats.views7d}`} />
              <StatCard label="Downloads (total)" value={stats.totalDownloads} sub="Best-effort count from /s/:shareId/pdf?download=1" />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <MiniBarSeries title="Views by day" subtitle={`Last-seen activity (UTC), last ${rangeDays} days`} series={stats.viewSeries} />
              <MiniBarSeries
                title="Downloads by day"
                subtitle={`UTC, last ${rangeDays} days`}
                series={stats.downloadSeries}
              />
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

            {stats.topDocs.length ? (
              <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4">
                <div className="text-sm font-semibold text-[var(--fg)]">Top docs (unique viewers)</div>
                <div className="mt-1 text-xs text-[var(--muted-2)]">From the loaded dataset</div>
                <div className="mt-4 space-y-2">
                  {stats.topDocs.map((d) => {
                    const max = stats.topDocs[0]?.count ?? 1;
                    const pct = Math.round((d.count / max) * 100);
                    return (
                      <div key={d.docId} className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/a/shareviews/${encodeURIComponent(d.docId)}`}
                            className="truncate text-sm font-semibold text-[var(--fg)] hover:underline"
                          >
                            {d.title}
                          </Link>
                          <div className="mt-1 h-2 rounded-full bg-[var(--panel-2)]">
                            <div className="h-2 rounded-full bg-[var(--primary-bg)]/70" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <div className="w-10 text-right text-xs text-[var(--muted-2)]">{d.count}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

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
            No views yet.
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {normalized.map((v) => {
              const { docId, title, shareId } = docInfo(v);
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
                      <div className="truncate text-sm font-semibold text-[var(--fg)]">
                        {docId ? (
                          <Link href={`/a/shareviews/${encodeURIComponent(docId)}`} className="hover:underline">
                            {title}
                          </Link>
                        ) : (
                          title
                        )}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-2)]">
                        Viewed: {viewedAt} • Pages seen: {pages}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-2)]">Viewer: {viewer}</div>
                      {v.viewerIp ? (
                        <div className="mt-1 text-xs text-[var(--muted-2)]">IP: {v.viewerIp}</div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      {shareId ? (
                        <a
                          href={`/s/${encodeURIComponent(shareId)}`}
                          className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open share
                        </a>
                      ) : null}
                      {docId ? (
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(docId)}`}
                          className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
                        >
                          All views
                        </Link>
                      ) : null}
                    </div>
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


