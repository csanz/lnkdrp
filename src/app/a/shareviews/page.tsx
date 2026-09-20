/**
 * Admin route: `/a/shareviews`
 *
 * The most recent share views across every document, one row per (share link, viewer). The
 * overview reads the whole loaded set; the search narrows the table under it, because two
 * hundred viewers as two hundred cards is a page you scroll past rather than read.
 *
 * The 200 rows arrive in one request and are paged here, fifty at a time, for the reason every
 * other list page pages: 200 rows was a 10,000px page whose column headers were gone after the
 * first screen and whose row actions were 400 buttons stacked down the right edge.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSection,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  RowActions,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, ADMIN_FOCUS_RING, ADMIN_ROW_ACTION_LINK } from "@/lib/admin/ui";
import {
  DaySeries,
  PagesDistribution,
  StatTile,
  buildDailySeriesFromDayMap,
  buildDailySeriesFromItems,
  docInfo,
  pagesBucket,
  safeDate,
  sumDownloadsByDay,
  viewerLabel,
  type ShareViewItem,
} from "@/lib/admin/shareViews";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

const COLUMN_COUNT = 7;

/** The rows come in one request; the table still pages like every other admin list. */
const PAGE_SIZE = 50;

/** Recent share views across the fleet. */
export default function ShareViewsAdminPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [items, setItems] = useState<ShareViewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<7 | 14 | 30>(14);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  const normalized = useMemo(() => (Array.isArray(items) ? items : []), [items]);

  const stats = useMemo(() => {
    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;
    const last24h = now - msDay;
    const last7d = now - 7 * msDay;

    let views24h = 0;
    let views7d = 0;
    const docCounts = new Map<string, { docId: string; title: string; count: number }>();
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

      const { docId, title } = docInfo(item);
      if (docId) {
        const prev = docCounts.get(docId);
        if (prev) prev.count += 1;
        else docCounts.set(docId, { docId, title, count: 1 });
      }

      const pages = Array.isArray(item.pagesSeen) ? item.pagesSeen.length : 0;
      totalPagesSeen += pages;
      const bucket = pagesBucket(pages);
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

  /** The table narrows on document title, viewer and IP; the overview above does not. */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return normalized;
    return normalized.filter((item) => {
      const { title } = docInfo(item);
      return (
        title.toLowerCase().includes(needle) ||
        viewerLabel(item).toLowerCase().includes(needle) ||
        (item.viewerIp ?? "").toLowerCase().includes(needle)
      );
    });
  }, [normalized, q]);

  /** The fifty rows this page of the table shows. */
  const pageItems = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  /** A search that shortens the list must not leave the pager on a page that no longer exists. */
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page > pages) setPage(1);
  }, [filtered.length, page]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ items?: unknown }>("/api/admin/shareviews/recent?limit=200", { method: "GET" });
        setItems(Array.isArray(data.items) ? (data.items as ShareViewItem[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share views");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, reloadKey]);

  if (!canUseAdmin) {
    return (
      <AdminAccessState
        access={access}
        title="Share views"
        description="The 200 most recent share views, one row per viewer of a link."
        callbackUrl="/a/shareviews"
      />
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Share views"
          description="The 200 most recent share views, one row per viewer of a link."
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
          noun="views"
          loading={loading}
          actions={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
              Refresh
            </Button>
          }
        >
          <AdminSearchInput
            value={q}
            onValueChange={(v) => {
              setPage(1);
              setQ(v);
            }}
            placeholder="Search document, viewer or IP…"
            ariaLabel="Search share views"
          />
          <AdminSelect
            ariaLabel="Chart range"
            value={String(rangeDays)}
            onChange={(e) => setRangeDays((Number(e.target.value) as 7 | 14 | 30) || 14)}
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        {normalized.length ? (
          <>
            {/* Both rows sit on one 12-column grid — four tiles at 3, three cards at 4 — so the
                card edges line up down the page instead of breaking at two sets of points. */}
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-12">
              <StatTile
                className="lg:col-span-3"
                label="Viewers"
                value={stats.totalViews.toLocaleString()}
                sub="One per link and viewer"
              />
              <StatTile className="lg:col-span-3" label="Docs touched" value={stats.docCount.toLocaleString()} />
              {/* One number per tile: the 7-day figure is the denominator, so it is muted. */}
              <StatTile
                className="lg:col-span-3"
                label="Views 24h"
                value={
                  <>
                    {stats.views24h.toLocaleString()}
                    <span className="text-[var(--muted-2)]"> / {stats.views7d.toLocaleString()}</span>
                  </>
                }
                sub="Of the last 7 days"
              />
              <StatTile
                className="lg:col-span-3"
                label="Downloads"
                value={stats.totalDownloads.toLocaleString()}
                sub="Best-effort, from the PDF route"
              />
            </div>

            <div className="mt-2 grid gap-2 lg:grid-cols-12">
              <DaySeries
                className="lg:col-span-6"
                title="Views by day"
                subtitle={`Last seen, UTC, ${rangeDays} days`}
                series={stats.viewSeries}
              />
              <DaySeries
                className="lg:col-span-3"
                title="Downloads by day"
                subtitle={`UTC, ${rangeDays} days`}
                series={stats.downloadSeries}
              />
              <PagesDistribution className="lg:col-span-3" counts={stats.pagesSeenCounts} />
            </div>

            {stats.topDocs.length ? (
              <AdminSection title="Top documents" description="Unique viewers per document, within the rows loaded above.">
                <AdminTable
                  ariaLabel="Top documents by unique viewers"
                  head={
                    <>
                      <AdminTh>Document</AdminTh>
                      <AdminTh align="right" width="w-[150px]">
                        Viewers
                      </AdminTh>
                      <AdminTh width="w-[140px]">Doc ID</AdminTh>
                    </>
                  }
                >
                  {stats.topDocs.map((d) => (
                    <AdminTr key={d.docId}>
                      <AdminTd primary truncate="max-w-[520px]">
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(d.docId)}`}
                          className={`rounded hover:underline ${ADMIN_FOCUS_RING}`}
                          title={d.title}
                        >
                          {d.title}
                        </Link>
                      </AdminTd>
                      {/* A count alone does not say how far ahead the top row is; the bar behind
                          it is this document's share of the busiest one. */}
                      <AdminTd align="right" numeric>
                        <span className="relative inline-flex h-5 w-[92px] items-center justify-end overflow-hidden rounded-[3px]">
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 right-0 rounded-[3px] bg-[var(--primary-bg)] opacity-20"
                            style={{
                              width: `${Math.max(4, Math.round((d.count / (stats.topDocs[0]?.count || 1)) * 100))}%`,
                            }}
                          />
                          <span className="relative px-1.5">{d.count.toLocaleString()}</span>
                        </span>
                      </AdminTd>
                      <AdminTd>
                        <IdCell value={d.docId} label="doc id" href={`/a/shareviews/${encodeURIComponent(d.docId)}`} />
                      </AdminTd>
                    </AdminTr>
                  ))}
                </AdminTable>
              </AdminSection>
            ) : null}
          </>
        ) : null}

        <AdminSection
          title="Recent views"
          description="Newest first, fifty to a page. One row per viewer of one link; the title opens every view of that document."
        >
          <AdminTable
            ariaLabel="Share views"
            head={
              <>
                <AdminTh>Document</AdminTh>
                <AdminTh>Viewer</AdminTh>
                <AdminTh align="right">Pages</AdminTh>
                <AdminTh align="right">Downloads</AdminTh>
                <AdminTh>IP</AdminTh>
                <AdminTh align="right">Last seen</AdminTh>
                <AdminTh align="right" sticky>
                  Actions
                </AdminTh>
              </>
            }
          >
            {loading && normalized.length === 0 ? (
              <AdminTableMessage colSpan={COLUMN_COUNT}>Loading share views…</AdminTableMessage>
            ) : filtered.length === 0 ? (
              <AdminTableEmpty
                colSpan={COLUMN_COUNT}
                title={q.trim() ? "No views match that search" : "No share views yet"}
                hint={q.trim() ? "Try a document title, a viewer's email or an IP." : undefined}
              />
            ) : (
              pageItems.map((v) => {
                const { docId, title } = docInfo(v);
                const pages = Array.isArray(v.pagesSeen) ? v.pagesSeen.length : 0;
                const downloads = typeof v.downloads === "number" ? v.downloads : Number(v.downloads ?? 0) || 0;
                const viewer = viewerLabel(v);
                return (
                  <AdminTr key={v._id}>
                    <AdminTd primary truncate="max-w-[280px]">
                      {docId ? (
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(docId)}`}
                          className={`rounded hover:underline ${ADMIN_FOCUS_RING}`}
                          title={title}
                        >
                          {title}
                        </Link>
                      ) : (
                        <span title={title}>{title}</span>
                      )}
                    </AdminTd>
                    <AdminTd truncate="max-w-[190px]">
                      <span title={viewer}>{viewer}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {pages ? pages.toLocaleString() : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {downloads ? downloads.toLocaleString() : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd mono truncate="max-w-[110px]">
                      <span title={v.viewerIp ?? undefined}>{v.viewerIp || ADMIN_DASH}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      <TimeCell value={v.updatedDate ?? v.createdDate ?? null} />
                    </AdminTd>
                    {/* One action, not two: "All views" repeated the link the document title
                        already carries, and a pair per row was 400 buttons down the page. */}
                    <AdminTd align="right" sticky actions>
                      <RowActions>
                        <span className="text-[12px] text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      </RowActions>
                    </AdminTd>
                  </AdminTr>
                );
              })
            )}
          </AdminTable>
        </AdminSection>
      </div>
    </div>
  );
}
