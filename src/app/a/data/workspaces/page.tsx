/**
 * Admin route: `/a/data/workspaces`
 *
 * Workspace inspector: a paged list of workspaces (team or personal) and the way in to
 * each one's hub. Same header/band/table shape as every other admin list.
 */
"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Link from "next/link";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  RowAction,
  RowActions,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type WorkspaceRow = {
  workspaceId: string;
  type: string | null;
  name: string | null;
  slug: string | null;
  memberCount: number;
  createdDate: string | null;
  updatedDate?: string | null;
};

type SortField = "createdDate" | "updatedDate";
type SortOrder = "desc" | "asc";

const COLUMN_COUNT = 7;

/** The workspaces list page. */
export default function AdminDataWorkspacesPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("team");
  const [sortField, setSortField] = useState<SortField>("createdDate");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteBusyWorkspaceId, setDeleteBusyWorkspaceId] = useState<string>("");

  const searching = Boolean(q.trim());

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
        if (typeFilter) qs.set("type", typeFilter);
        qs.set("sort", sortField);
        qs.set("order", sortOrder);
        const data = await fetchJson<{ workspaces?: unknown; total?: unknown }>(`/api/admin/data/workspaces?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.workspaces) ? (data.workspaces as WorkspaceRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load workspaces");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, typeFilter, sortField, sortOrder, reloadKey]);

  /** Soft-delete one workspace (confirms first) and drop it from the loaded page. */
  async function deleteWorkspace(workspaceId: string) {
    if (!workspaceId) return;
    if (deleteBusyWorkspaceId) return;
    const ok = window.confirm(
      `Soft-delete workspace ${workspaceId}?\n\nThis does NOT cascade-delete related records. Use with care.`,
    );
    if (!ok) return;
    setDeleteBusyWorkspaceId(workspaceId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((w) => w.workspaceId !== workspaceId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete workspace");
    } finally {
      setDeleteBusyWorkspaceId("");
    }
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Workspaces" description="Every workspace on this deployment. Open one for its plan, credits and activity." callbackUrl="/a/data/workspaces" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Workspaces"
          description="Every workspace on this deployment. Open one for its plan, credits and activity."
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="workspaces"
          loading={loading}
          actions={
            <Button variant="outline" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
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
            placeholder="Search name or slug…"
            ariaLabel="Search workspaces by name or slug"
          />
          <AdminSelect
            ariaLabel="Filter by workspace type"
            value={typeFilter}
            onChange={(e) => {
              setPage(1);
              setTypeFilter(e.target.value);
            }}
          >
            <option value="team">Team workspaces</option>
            <option value="personal">Personal workspaces</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Sort workspaces"
            value={`${sortField}:${sortOrder}`}
            onChange={(e) => {
              const raw = e.target.value || "createdDate:desc";
              const [f, o] = raw.split(":");
              const nextField = (f === "updatedDate" ? "updatedDate" : "createdDate") as SortField;
              const nextOrder = (o === "asc" ? "asc" : "desc") as SortOrder;
              setPage(1);
              setSortField(nextField);
              setSortOrder(nextOrder);
            }}
          >
            <option value="createdDate:desc">Created (newest)</option>
            <option value="createdDate:asc">Created (oldest)</option>
            <option value="updatedDate:desc">Updated (newest)</option>
            <option value="updatedDate:asc">Updated (oldest)</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Workspaces"
          head={
            <>
              {/* The two text columns share the slack; the counts, dates and the id are sized
                  to their own content, so a date column can never drift from its header and
                  the id header is never squeezed under the sticky Actions cell. */}
              <AdminTh>Workspace</AdminTh>
              <AdminTh>Slug</AdminTh>
              <AdminTh align="right" width="w-[86px]">
                Members
              </AdminTh>
              <AdminTh align="right" width="w-[116px]">
                Created
              </AdminTh>
              <AdminTh align="right" width="w-[116px]">
                Updated
              </AdminTh>
              <AdminTh width="w-[124px]">Workspace ID</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading workspaces…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={searching ? "No workspaces match that search" : "No workspaces of this type"}
              hint={searching ? "Try a different name or slug." : "Switch the type filter to see the others."}
            />
          ) : (
            items.map((w) => (
              <AdminTr key={w.workspaceId}>
                <AdminTd primary truncate="max-w-[280px]">
                  <Link
                    href={`/a/data/workspaces/${encodeURIComponent(w.workspaceId)}`}
                    className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    title={w.name ?? "Open workspace hub"}
                  >
                    {w.name ?? ADMIN_DASH}
                  </Link>
                </AdminTd>
                <AdminTd truncate="max-w-[200px]">
                  <span title={w.slug ?? undefined}>{w.slug ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  {Number.isFinite(w.memberCount) ? w.memberCount.toLocaleString() : ADMIN_DASH}
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={w.createdDate} />
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={w.updatedDate ?? null} />
                </AdminTd>
                <AdminTd>
                  <IdCell
                    value={w.workspaceId}
                    label="workspace id"
                    href={`/a/data/workspaces/${encodeURIComponent(w.workspaceId)}`}
                  />
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  <RowActions>
                    <RowAction
                      tone="danger"
                      busy={deleteBusyWorkspaceId === w.workspaceId}
                      busyLabel="Deleting…"
                      disabled={Boolean(deleteBusyWorkspaceId) && deleteBusyWorkspaceId !== w.workspaceId}
                      title="Soft delete workspace"
                      onClick={() => void deleteWorkspace(w.workspaceId)}
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
