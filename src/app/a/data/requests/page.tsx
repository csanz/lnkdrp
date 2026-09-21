/**
 * Admin route: `/a/data/requests`
 *
 * Lists request link repos for admin inspection (paged). Built on the shared admin UI in
 * `@/components/admin` — see `/a/data/users` for the reference implementation.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  BoolState,
  IdCell,
  RowAction,
  RowActions,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type RequestRow = {
  id: string;
  userId: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  docCount: number | null;
  isRequest: boolean;
  /** Which capability tokens exist on the row — never their values. See src/lib/admin/docPrivacy.ts. */
  secrets?: { hasShareLink?: boolean | null; hasRequestUploadToken?: boolean | null } | null;
  requestReviewEnabled: boolean;
  updatedDate: string | null;
  createdDate: string | null;
};

/** Column count of the table below; every full-width row's colSpan has to match it. */
const COLUMN_COUNT = 9;

/** The Requests browser: every request repo, filtered and paged server-side. */
export default function AdminDataRequestsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBusyRequestId, setDeleteBusyRequestId] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  /** A search narrowing the list — decides which empty-state sentence the table shows. */
  const filtered = Boolean(q.trim());

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        const data = await fetchJson<{ requests?: unknown; total?: unknown }>(
          `/api/admin/data/requests?${qs.toString()}`,
          { method: "GET" },
        );
        setItems(Array.isArray(data.requests) ? (data.requests as RequestRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load requests");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, reloadKey]);

  /** Soft-delete a request repo, then drop its row optimistically. */
  async function deleteRequest(requestId: string) {
    if (!requestId) return;
    if (deleteBusyRequestId) return;
    const ok = window.confirm(`Soft-delete request repo ${requestId}?\n\nThis will hide it from normal views.`);
    if (!ok) return;
    setDeleteBusyRequestId(requestId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/requests/${encodeURIComponent(requestId)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((r) => r.id !== requestId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete request");
    } finally {
      setDeleteBusyRequestId("");
    }
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Requests" description="Request repos: the folders people upload into from a public link." callbackUrl="/a/data/requests" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Requests" description="Request repos: the folders people upload into from a public link." />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="requests"
          loading={loading}
          actions={
            <Button variant="outline" className="bg-[var(--panel)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          }
        >
          <AdminSearchInput
            value={q}
            onValueChange={(v) => {
              setPage(1);
              setQ(v);
            }}
            placeholder="Search name, slug, shareId…"
            ariaLabel="Search requests by name, slug, shareId or token"
          />
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Request repos"
          head={
            <>
              <AdminTh>Name</AdminTh>
              <AdminTh>Slug</AdminTh>
              <AdminTh align="right">Docs</AdminTh>
              <AdminTh>Review</AdminTh>
              <AdminTh>Accepting</AdminTh>
              <AdminTh align="right">Updated</AdminTh>
              <AdminTh>User</AdminTh>
              <AdminTh>Request ID</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading requests…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={filtered ? "No requests match that search" : "No request repos yet"}
              hint={
                filtered
                  ? "Try a different name, slug, shareId or token."
                  : "A request repo appears here once someone creates a request link."
              }
            />
          ) : (
            items.map((r) => (
              <AdminTr key={r.id}>
                {/* The description is the row's tooltip rather than a second line, so every
                    request keeps the same one-line rhythm. */}
                <AdminTd primary truncate="max-w-[190px] sm:max-w-[260px]">
                  <Link
                    href={`/a/data/requests/${encodeURIComponent(r.id)}`}
                    className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    title={r.description ? `${r.name ?? "Untitled"} — ${r.description}` : (r.name ?? "Open request")}
                  >
                    {r.name ?? ADMIN_DASH}
                  </Link>
                </AdminTd>
                <AdminTd truncate="max-w-[170px]">
                  <span title={r.slug ?? undefined}>{r.slug ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  {typeof r.docCount === "number" ? r.docCount.toLocaleString() : ADMIN_DASH}
                </AdminTd>
                <AdminTd>
                  <BoolState value={r.requestReviewEnabled} trueLabel="On" />
                </AdminTd>
                {/* Whether the repo has a live upload token, not a link to it. This cell used to
                    be `/request/<token>`, opening the customer's own upload page — an unauthenticated
                    write capability into their workspace, rendered as a convenience. */}
                <AdminTd>
                  <BoolState value={Boolean(r.secrets?.hasRequestUploadToken)} trueLabel="Yes" />
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={r.updatedDate ?? r.createdDate} />
                </AdminTd>
                <AdminTd>
                  <IdCell
                    value={r.userId}
                    label="user id"
                    href={r.userId ? `/a/data/users/${encodeURIComponent(r.userId)}` : undefined}
                  />
                </AdminTd>
                <AdminTd>
                  <IdCell value={r.id} label="request id" href={`/a/data/requests/${encodeURIComponent(r.id)}`} />
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  <RowActions>
                    <RowAction
                      tone="danger"
                      busy={deleteBusyRequestId === r.id}
                      busyLabel="Deleting…"
                      disabled={Boolean(deleteBusyRequestId) && deleteBusyRequestId !== r.id}
                      title="Soft delete request repo"
                      onClick={() => void deleteRequest(r.id)}
                    >
                      Delete
                    </RowAction>
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>
      </div>
    </div>
  );
}
