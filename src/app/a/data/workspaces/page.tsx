/**
 * Admin route: `/a/data/workspaces`
 *
 * Workspace inspector: paged list of workspaces (team orgs) and drill-in to members.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import Link from "next/link";
import Select from "@/components/ui/Select";
import { fmtDate } from "@/lib/admin/format";
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

export default function AdminDataWorkspacesPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

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

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

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

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Workspaces</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/workspaces" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Workspaces</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Workspaces</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of workspaces. Click a workspace to view members.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search workspace name or slug…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <Select
              className="w-[170px] max-w-full"
              value={typeFilter}
              onChange={(e) => {
                setPage(1);
                setTypeFilter(e.target.value);
              }}
              title="Filter by type"
            >
              <option value="team">Team workspaces</option>
              <option value="personal">Personal workspaces</option>
            </Select>
            <Select
              className="w-[200px] max-w-full"
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
              title="Sort"
            >
              <option value="createdDate:desc">Created (newest)</option>
              <option value="createdDate:asc">Created (oldest)</option>
              <option value="updatedDate:desc">Updated (newest)</option>
              <option value="updatedDate:asc">Updated (oldest)</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={loading}
              onClick={() => setReloadKey((v) => v + 1)}
            >
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-6 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Workspace</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Workspace ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((w) => (
                <tr key={w.workspaceId}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/a/data/workspaces/${encodeURIComponent(w.workspaceId)}`}
                      className="font-semibold text-[var(--fg)] hover:underline"
                      title="View members for this workspace"
                    >
                      {w.name ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{w.slug ?? "—"}</td>
                  <td className="px-4 py-3">{Number.isFinite(w.memberCount) ? w.memberCount : "—"}</td>
                  <td className="px-4 py-3">{fmtDate(w.createdDate) || "—"}</td>
                  <td className="px-4 py-3">{fmtDate(w.updatedDate ?? null) || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{w.workspaceId}</td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={6}>
                    No workspaces.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}


