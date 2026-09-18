/**
 * Admin route: `/a/shareviews/:docId`
 *
 * Every distinct viewer of one document: the same reading as the fleet page, scoped down. The
 * overview covers all of them; the search narrows the table, and the table pages fifty at a time
 * like every other admin list.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
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
import { ADMIN_DASH, ADMIN_ROW_ACTION_LINK } from "@/lib/admin/ui";
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

/** One request brings every viewer of the document; the table pages them like every other list. */
const PAGE_SIZE = 50;

/** All distinct viewers of one document. */
export default function ShareViewsDocAdminPage() {
  // `params` reaches a client component as a promise, so reading `params.docId` off the prop left
  // the id undefined and the page fetched nothing. Every other admin detail page reads the hook.
  const routeParams = useParams<{ docId: string }>();
  const docId = typeof routeParams?.docId === "string" ? routeParams.docId : "";
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
      const bucket = pagesBucket(pages);
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return normalized;
    return normalized.filter(
      (item) =>
        viewerLabel(item).toLowerCase().includes(needle) ||
        (item.shareId ?? "").toLowerCase().includes(needle) ||
        (item.viewerIp ?? "").toLowerCase().includes(needle),
    );
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
    if (!docId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ items?: unknown }>(`/api/admin/shareviews/doc/${encodeURIComponent(docId)}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.items) ? (data.items as ShareViewItem[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share views");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, docId, reloadKey]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Share views" callbackUrl={`/a/shareviews/${encodeURIComponent(docId)}`} />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title={header?.title ?? "Document"}
          description="Every distinct viewer of this document, newest first."
          actions={
            <>
              <Link href="/a/shareviews" className={ADMIN_ROW_ACTION_LINK}>
                All share views
              </Link>
              {header?.shareId ? (
                <></>
              ) : null}
            </>
          }
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
          noun="viewers"
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
            placeholder="Search viewer, share or IP…"
            ariaLabel="Search viewers of this document"
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

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        {normalized.length ? (
          <>
            {/* Tiles and charts share one 12-column grid — four at 3, three at 4 — so the two
                rows break at the same points and their edges line up. */}
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-12">
              <StatTile
                className="lg:col-span-3"
                label="Viewers"
                value={stats.totalViews.toLocaleString()}
                sub="One per link and viewer"
              />
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
              <StatTile className="lg:col-span-3" label="Avg pages seen" value={stats.avgPages.toFixed(1)} />
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
          </>
        ) : null}

        <AdminSection title="Viewers" description="One row per viewer of one link to this document, fifty to a page.">
          <AdminTable
            ariaLabel="Viewers of this document"
            head={
              <>
                <AdminTh>Viewer</AdminTh>
                <AdminTh align="right">Pages</AdminTh>
                <AdminTh align="right">Downloads</AdminTh>
                <AdminTh>IP</AdminTh>
                <AdminTh align="right">Last seen</AdminTh>
                <AdminTh>Share</AdminTh>
                <AdminTh align="right" sticky>
                  Actions
                </AdminTh>
              </>
            }
          >
            {loading && normalized.length === 0 ? (
              <AdminTableMessage colSpan={COLUMN_COUNT}>Loading viewers…</AdminTableMessage>
            ) : filtered.length === 0 ? (
              <AdminTableEmpty
                colSpan={COLUMN_COUNT}
                title={q.trim() ? "No viewers match that search" : "No views for this document yet"}
                hint={q.trim() ? "Try an email, a share id or an IP." : undefined}
              />
            ) : (
              pageItems.map((v) => {
                const pages = Array.isArray(v.pagesSeen) ? v.pagesSeen.length : 0;
                const downloads = typeof v.downloads === "number" ? v.downloads : Number(v.downloads ?? 0) || 0;
                const viewer = viewerLabel(v);
                return (
                  <AdminTr key={v._id}>
                    <AdminTd primary truncate="max-w-[320px]">
                      <span title={viewer}>{viewer}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {pages ? pages.toLocaleString() : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {downloads ? downloads.toLocaleString() : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd mono truncate="max-w-[160px]">
                      <span title={v.viewerIp ?? undefined}>{v.viewerIp || ADMIN_DASH}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      <TimeCell value={v.updatedDate ?? v.createdDate ?? null} />
                    </AdminTd>
                    <AdminTd>
                      <IdCell value={v.shareId} label="share id" head={8} tail={4} />
                    </AdminTd>
                    <AdminTd align="right" sticky actions>
                      <RowActions>
                        {v.shareId ? (
                          <span className="text-[12px] text-[var(--muted-2)]">—</span>
                        ) : (
                          <span className="text-[12px] text-[var(--muted-2)]">{ADMIN_DASH}</span>
                        )}
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
