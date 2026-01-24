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

type UploadSummary = {
  id: string;
  userId: string | null;
  orgId?: string | null;
  docId: string | null;
  version: number | null;
  status: string | null;
  originalFileName?: string | null;
  previewImageUrl?: string | null;
  firstPagePngUrl?: string | null;
  blobUrl?: string | null;
  blobPathname?: string | null;
  error?: unknown | null;
  createdDate: string | null;
  updatedDate?: string | null;
};

type AdminDocDetailsResponse = {
  ok?: boolean;
  doc?: any;
  uploads?: UploadSummary[];
  error?: string;
};

type AdminUploadDetailsResponse = {
  ok?: boolean;
  upload?: any;
  error?: string;
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

  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [docDetails, setDocDetails] = useState<AdminDocDetailsResponse | null>(null);

  const [selectedUploadId, setSelectedUploadId] = useState<string>("");
  const [uploadDetailsLoading, setUploadDetailsLoading] = useState(false);
  const [uploadDetailsError, setUploadDetailsError] = useState<string | null>(null);
  const [uploadDetails, setUploadDetails] = useState<AdminUploadDetailsResponse | null>(null);

  const [docJsonCopyDone, setDocJsonCopyDone] = useState(false);
  const [uploadJsonCopyDone, setUploadJsonCopyDone] = useState(false);

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function loadDocDetails(docId: string) {
    if (!docId) return;
    setDetailsLoading(true);
    setDetailsError(null);
    setDocDetails(null);
    setSelectedUploadId("");
    setUploadDetails(null);
    setUploadDetailsError(null);
    setDocJsonCopyDone(false);
    setUploadJsonCopyDone(false);
    try {
      const data = await fetchJson<AdminDocDetailsResponse>(`/api/admin/data/docs/${encodeURIComponent(docId)}`, {
        method: "GET",
      });
      setDocDetails(data);
    } catch (e) {
      setDetailsError(e instanceof Error ? e.message : "Failed to load doc details");
    } finally {
      setDetailsLoading(false);
    }
  }

  async function loadUploadDetails(uploadId: string) {
    if (!uploadId) return;
    setUploadDetailsLoading(true);
    setUploadDetailsError(null);
    setUploadDetails(null);
    setUploadJsonCopyDone(false);
    try {
      const data = await fetchJson<AdminUploadDetailsResponse>(`/api/admin/data/uploads/${encodeURIComponent(uploadId)}`, {
        method: "GET",
      });
      setUploadDetails(data);
    } catch (e) {
      setUploadDetailsError(e instanceof Error ? e.message : "Failed to load upload details");
    } finally {
      setUploadDetailsLoading(false);
    }
  }

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
      <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
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

        <div className={["mt-6 grid gap-5", selectedDocId ? "lg:grid-cols-[1fr_520px]" : ""].join(" ")}>
          <div className="min-w-0">
            {loading ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                Loading…
              </div>
            ) : (
              <DataTable>
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
                    <tr
                      key={d.id}
                      className={selectedDocId === d.id ? "bg-[var(--panel-2)]/60" : ""}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => {
                            setSelectedDocId(d.id);
                            void loadDocDetails(d.id);
                          }}
                          title="Open details"
                        >
                          {d.title ?? "—"}
                        </button>
                      </td>
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
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                            onClick={() => {
                              setSelectedDocId(d.id);
                              void loadDocDetails(d.id);
                            }}
                          >
                            Details
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-red-500 hover:bg-[var(--panel-hover)] disabled:opacity-60"
                            disabled={Boolean(deleteBusyDocId) && deleteBusyDocId !== d.id}
                            onClick={() => void deleteDoc(d.id)}
                            title="Soft delete doc"
                          >
                            {deleteBusyDocId === d.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
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

          {selectedDocId ? (
            <aside className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 lg:sticky lg:top-6 lg:max-h-[calc(100svh-80px)] lg:overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--fg)]">Doc details</div>
                  <div className="mt-1 font-mono text-xs text-[var(--muted)] break-all">{selectedDocId}</div>
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                  onClick={() => {
                    setSelectedDocId("");
                    setDocDetails(null);
                    setDetailsError(null);
                    setSelectedUploadId("");
                    setUploadDetails(null);
                    setUploadDetailsError(null);
                  }}
                >
                  Close
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                  href={`/doc/${encodeURIComponent(selectedDocId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open /doc
                </a>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-60"
                  disabled={detailsLoading}
                  onClick={() => void loadDocDetails(selectedDocId)}
                >
                  {detailsLoading ? "Loading…" : "Refresh"}
                </button>
              </div>

              {detailsError ? (
                <Alert variant="info" className="mt-3 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
                  {detailsError}
                </Alert>
              ) : null}

              {detailsLoading && !docDetails ? (
                <div className="mt-3 text-sm text-[var(--muted)]">Loading doc JSON…</div>
              ) : docDetails?.doc ? (
                <>
                  <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Key fields</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div className="text-[var(--muted)]">status</div>
                      <div className="font-mono text-[var(--fg)]">{String(docDetails.doc.status ?? "—")}</div>
                      <div className="text-[var(--muted)]">currentUploadId</div>
                      <div className="font-mono text-[var(--fg)] break-all">{String(docDetails.doc.currentUploadId ?? docDetails.doc.uploadId ?? "—")}</div>
                      <div className="text-[var(--muted)]">previewImageUrl</div>
                      <div className={["font-mono break-all", docDetails.doc.previewImageUrl ? "text-[var(--fg)]" : "text-red-500"].join(" ")}>
                        {String(docDetails.doc.previewImageUrl ?? docDetails.doc.firstPagePngUrl ?? "null")}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Uploads</div>
                    {Array.isArray(docDetails.uploads) && docDetails.uploads.length ? (
                      <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
                        <div className="px-3 pt-2 text-[11px] text-[var(--muted-2)]">
                          Showing latest {Math.min(5, docDetails.uploads.length)} of {docDetails.uploads.length}
                        </div>
                        <div className="max-h-[220px] overflow-auto">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-[var(--panel-2)]">
                              <tr className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                                <th className="px-3 py-2 text-left">v</th>
                                <th className="px-3 py-2 text-left">status</th>
                                <th className="px-3 py-2 text-left">preview</th>
                                <th className="px-3 py-2 text-left">error</th>
                                <th className="px-3 py-2 text-left">open</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--border)]">
                              {docDetails.uploads.slice(0, 5).map((u) => {
                                const hasPreview = Boolean(u.previewImageUrl || u.firstPagePngUrl);
                                const errMsg =
                                  u.error && typeof u.error === "object" && (u.error as any).message
                                    ? String((u.error as any).message)
                                    : "";
                                return (
                                  <tr
                                    key={u.id}
                                    className={selectedUploadId === u.id ? "bg-[var(--panel)]/80" : ""}
                                  >
                                    <td className="px-3 py-2 font-mono">{typeof u.version === "number" ? u.version : "—"}</td>
                                    <td className="px-3 py-2">{u.status ?? "—"}</td>
                                    <td className={["px-3 py-2 font-semibold", hasPreview ? "text-emerald-500" : "text-red-500"].join(" ")}>
                                      {hasPreview ? "yes" : "no"}
                                    </td>
                                    <td className="px-3 py-2">
                                      <button
                                        type="button"
                                        className="font-mono text-[11px] text-[var(--muted)] hover:underline"
                                        onClick={() => {
                                          setSelectedUploadId(u.id);
                                          void loadUploadDetails(u.id);
                                        }}
                                        title={errMsg || "Open upload JSON"}
                                      >
                                        {errMsg ? errMsg.slice(0, 42) : "view"}
                                      </button>
                                    </td>
                                    <td className="px-3 py-2">
                                      <a
                                        className="font-mono text-[11px] text-[var(--muted)] hover:underline"
                                        href={`/a/data/uploads?uploadId=${encodeURIComponent(u.id)}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        title="Open in /a/data/uploads"
                                      >
                                        /a/data/uploads
                                      </a>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-sm text-[var(--muted)]">No uploads found for this doc.</div>
                    )}
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Doc JSON</div>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-60"
                        disabled={!docDetails?.doc}
                        onClick={() => {
                          const txt = docDetails?.doc ? JSON.stringify(docDetails.doc, null, 2) : "";
                          void (async () => {
                            const ok = await copyToClipboard(txt);
                            if (!ok) return;
                            setDocJsonCopyDone(true);
                            window.setTimeout(() => setDocJsonCopyDone(false), 1200);
                          })();
                        }}
                      >
                        {docJsonCopyDone ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                      {JSON.stringify(docDetails.doc, null, 2)}
                    </pre>
                  </div>

                  {selectedUploadId ? (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Upload JSON
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-60"
                            disabled={!uploadDetails?.upload}
                            onClick={() => {
                              const txt = uploadDetails?.upload ? JSON.stringify(uploadDetails.upload, null, 2) : "";
                              void (async () => {
                                const ok = await copyToClipboard(txt);
                                if (!ok) return;
                                setUploadJsonCopyDone(true);
                                window.setTimeout(() => setUploadJsonCopyDone(false), 1200);
                              })();
                            }}
                          >
                            {uploadJsonCopyDone ? "Copied" : "Copy"}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-hover)]"
                            onClick={() => {
                              setSelectedUploadId("");
                              setUploadDetails(null);
                              setUploadDetailsError(null);
                            }}
                          >
                            Clear
                          </button>
                        </div>
                      </div>

                      {uploadDetailsError ? (
                        <Alert variant="info" className="mt-2 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
                          {uploadDetailsError}
                        </Alert>
                      ) : null}
                      {uploadDetailsLoading && !uploadDetails ? (
                        <div className="mt-2 text-sm text-[var(--muted)]">Loading upload JSON…</div>
                      ) : uploadDetails?.upload ? (
                        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                          {JSON.stringify(uploadDetails.upload, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-3 text-sm text-[var(--muted)]">Select a doc to view details.</div>
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}




