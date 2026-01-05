/**
 * Admin route: `/a/data/docs`
 *
 * Lists docs across all users for admin inspection (paged).
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type DocRow = {
  id: string;
  userId: string | null;
  title: string | null;
  status: string | null;
  shareId: string | null;
  isArchived: boolean;
  updatedDate: string | null;
  createdDate: string | null;
};

type SortField = "updatedDate" | "createdDate";
type SortOrder = "desc" | "asc";

export default function AdminDataDocsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [archivedFilter, setArchivedFilter] = useState<string>("");
  const [sortField, setSortField] = useState<SortField>("updatedDate");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteBusyDocId, setDeleteBusyDocId] = useState<string>("");

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
        if (statusFilter) qs.set("status", statusFilter);
        if (archivedFilter) qs.set("archived", archivedFilter);
        qs.set("sort", sortField);
        qs.set("order", sortOrder);
        const data = await fetchJson<{ docs?: unknown; total?: unknown }>(`/api/admin/data/docs?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.docs) ? (data.docs as DocRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load docs");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, statusFilter, archivedFilter, sortField, sortOrder, reloadKey]);

  async function deleteDoc(docId: string) {
    if (!docId) return;
    if (deleteBusyDocId) return;
    const ok = window.confirm(`Soft-delete doc ${docId}?\n\nThis will hide it from normal views.`);
    if (!ok) return;
    setDeleteBusyDocId(docId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/docs/${encodeURIComponent(docId)}`, { method: "DELETE" });
      // Optimistic removal.
      setItems((prev) => prev.filter((d) => d.id !== docId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete doc");
    } finally {
      setDeleteBusyDocId("");
    }
  }

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Docs</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/docs" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Docs</div>
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
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Docs</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of docs across all users.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search title or shareId…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <Select
              className="w-[160px] max-w-full"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value);
              }}
              title="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="draft">draft</option>
              <option value="preparing">preparing</option>
              <option value="ready">ready</option>
              <option value="failed">failed</option>
            </Select>
            <Select
              className="w-[150px] max-w-full"
              value={archivedFilter}
              onChange={(e) => {
                setPage(1);
                setArchivedFilter(e.target.value);
              }}
              title="Filter by archived"
            >
              <option value="">All</option>
              <option value="no">Not archived</option>
              <option value="yes">Archived</option>
            </Select>
            <Select
              className="w-[180px] max-w-full"
              value={`${sortField}:${sortOrder}`}
              onChange={(e) => {
                const raw = e.target.value || "updatedDate:desc";
                const [f, o] = raw.split(":");
                const nextField = (f === "createdDate" ? "createdDate" : "updatedDate") as SortField;
                const nextOrder = (o === "asc" ? "asc" : "desc") as SortOrder;
                setPage(1);
                setSortField(nextField);
                setSortOrder(nextOrder);
              }}
              title="Sort"
            >
              <option value="updatedDate:desc">Updated (newest)</option>
              <option value="updatedDate:asc">Updated (oldest)</option>
              <option value="createdDate:desc">Created (newest)</option>
              <option value="createdDate:asc">Created (oldest)</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
            <Button variant="outline" className="bg-[var(--panel-2)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
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
        ) : (
          <DataTable containerClassName="mt-6">
            <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3">Share</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">User ID</th>
                <th className="px-4 py-3">Doc ID</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3">{d.title ?? "—"}</td>
                  <td className="px-4 py-3">{d.status ?? "—"}</td>
                  <td className="px-4 py-3">{d.isArchived ? "Yes" : "No"}</td>
                  <td className="px-4 py-3">
                    {d.shareId ? (
                      <a
                        className="text-[var(--fg)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--muted)]"
                        href={`/s/${encodeURIComponent(d.shareId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        /s/{d.shareId}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">{fmtDate(d.updatedDate) || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{d.userId ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/a/shareviews/${encodeURIComponent(d.id)}`}
                      className="font-mono text-xs text-[var(--muted)] hover:underline"
                      title="Open Share Views drilldown for this doc"
                    >
                      {d.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-red-500 hover:bg-[var(--panel-hover)] disabled:opacity-60"
                      disabled={Boolean(deleteBusyDocId) && deleteBusyDocId !== d.id}
                      onClick={() => void deleteDoc(d.id)}
                      title="Soft delete doc"
                    >
                      {deleteBusyDocId === d.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                    No docs.
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




