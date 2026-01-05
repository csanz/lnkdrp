/**
 * Admin route: `/a/data/projects`
 *
 * Lists projects across all users (paged) for admin inspection.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import DataTable from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type ProjectRow = {
  id: string;
  userId: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  shareId: string | null;
  docCount: number | null;
  isRequest: boolean;
  requestUploadToken: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

export default function AdminDataProjectsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBusyProjectId, setDeleteBusyProjectId] = useState<string>("");
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
        const data = await fetchJson<{ projects?: unknown; total?: unknown }>(`/api/admin/data/projects?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.projects) ? (data.projects as ProjectRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, reloadKey]);

  async function deleteProject(projectId: string) {
    if (!projectId) return;
    if (deleteBusyProjectId) return;
    const ok = window.confirm(`Soft-delete project ${projectId}?\n\nThis will hide it from normal views.`);
    if (!ok) return;
    setDeleteBusyProjectId(projectId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((p) => p.id !== projectId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    } finally {
      setDeleteBusyProjectId("");
    }
  }

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Projects</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/projects" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Projects</div>
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
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Projects</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of projects across all users.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search name, slug, shareId, token…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
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
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Docs</th>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">User ID</th>
                <th className="px-4 py-3">Project ID</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <div className="min-w-0">
                      <Link
                        href={`/a/data/projects/${encodeURIComponent(p.id)}`}
                        className="truncate font-semibold text-[var(--fg)] hover:underline"
                        title="Open project editor"
                      >
                        {p.name ?? "—"}
                      </Link>
                      {p.description ? <div className="mt-1 truncate text-xs text-[var(--muted)]">{p.description}</div> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">{p.slug ?? "—"}</td>
                  <td className="px-4 py-3">{p.isRequest || p.requestUploadToken ? "Request" : "Project"}</td>
                  <td className="px-4 py-3">{typeof p.docCount === "number" ? p.docCount : "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                    {p.requestUploadToken ? `${p.requestUploadToken.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="px-4 py-3">{fmtDate(p.updatedDate) || fmtDate(p.createdDate) || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{p.userId ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{p.id}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-red-500 hover:bg-[var(--panel-hover)] disabled:opacity-60"
                      disabled={Boolean(deleteBusyProjectId) && deleteBusyProjectId !== p.id}
                      onClick={() => void deleteProject(p.id)}
                      title="Soft delete project"
                    >
                      {deleteBusyProjectId === p.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={9}>
                    No projects.
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


