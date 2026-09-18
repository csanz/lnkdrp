/**
 * Admin route: `/a/data/docs`
 *
 * Lists docs across all users for admin inspection (paged), with a detail drawer that
 * carries the raw doc JSON and the uploads behind it. Built on the shared admin UI in
 * `@/components/admin` — see `/a/data/users` for the reference implementation.
 */
"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import Button from "@/components/ui/Button";
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
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_NO_CONTENT_NOTE } from "@/lib/admin/docPrivacy";
import { ADMIN_DASH, ADMIN_FOCUS_RING, statusLabel, type AdminTone } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { pipelineStatusTone } from "@/lib/admin/statusTones";
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

/** Column count of the table below; every full-width row's colSpan has to match it. */
const COLUMN_COUNT = 6;

/**
 * One state per row, not two columns of chrome.
 *
 * Status was a "Ready" pill on all 129 rows beside a separate ARCHIVED column — a wall of
 * repeated chips where only the exception matters. Archived outranks the pipeline status
 * (an archived document is not waiting on anything), the failure states get the only
 * colour, and the happy path is a plain muted word rather than a chip drawn 129 times.
 */
function docState(status: string | null, archived: boolean): { label: string; tone: AdminTone | null } {
  if (archived) return { label: "Archived", tone: "neutral" };
  const s = (status ?? "").trim();
  if (!s) return { label: ADMIN_DASH, tone: null };
  if (s.toLowerCase() === "ready") return { label: statusLabel(s), tone: null };
  return { label: statusLabel(s), tone: pipelineStatusTone(s) };
}

/** The Documents browser: every document across all users, with a detail drawer. */
export default function AdminDataDocsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

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

  /** Any filter narrowing the list — decides which empty-state sentence the table shows. */
  const filtered = Boolean(q.trim() || statusFilter || archivedFilter);

  /** Best-effort clipboard write; returns false when the browser refuses. */
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Load one document's raw record and its uploads into the detail drawer. */
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

  /** Load one upload's raw record, shown under the document JSON. */
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

  /** Soft-delete a document, then drop its row optimistically. */
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

  /** Select a row and open the detail drawer on it. */
  function openDetails(docId: string) {
    setSelectedDocId(docId);
    void loadDocDetails(docId);
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Documents" description="Every document across all users. Open one for its raw record and uploads." callbackUrl="/a/data/docs" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Documents" description="Every document across all users. Open one for its raw record and uploads." />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="docs"
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
            placeholder="Search title or shareId…"
            ariaLabel="Search documents by title or shareId"
          />
          <AdminSelect
            ariaLabel="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="preparing">Preparing</option>
            <option value="ready">Ready</option>
            <option value="failed">Failed</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Filter by archived"
            value={archivedFilter}
            onChange={(e) => {
              setPage(1);
              setArchivedFilter(e.target.value);
            }}
          >
            <option value="">All documents</option>
            <option value="no">Not archived</option>
            <option value="yes">Archived</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Sort documents"
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
          >
            <option value="updatedDate:desc">Updated (newest)</option>
            <option value="updatedDate:asc">Updated (oldest)</option>
            <option value="createdDate:desc">Created (newest)</option>
            <option value="createdDate:asc">Created (oldest)</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <div className={["mt-3 grid gap-4", selectedDocId ? "lg:grid-cols-[1fr_480px]" : ""].join(" ")}>
          <div className="min-w-0">
            <AdminTable
              ariaLabel="Documents"
              head={
                <>
                  {/* Identity first and widest; the two opaque ids sit last. */}
                  <AdminTh>Title</AdminTh>
                  <AdminTh width="w-[120px]">State</AdminTh>
                  <AdminTh align="right" width="w-[130px]">Updated</AdminTh>
                  <AdminTh width="w-[150px]">Share</AdminTh>
                  <AdminTh width="w-[130px]">Doc ID</AdminTh>
                  <AdminTh align="right" sticky>
                    Actions
                  </AdminTh>
                </>
              }
            >
              {loading && items.length === 0 ? (
                <AdminTableMessage colSpan={COLUMN_COUNT}>Loading documents…</AdminTableMessage>
              ) : items.length === 0 ? (
                <AdminTableEmpty
                  colSpan={COLUMN_COUNT}
                  title={filtered ? "No documents match that search" : "No documents yet"}
                  hint={filtered ? "Try a different title, status or archived filter." : undefined}
                />
              ) : (
                items.map((d) => (
                  <AdminTr key={d.id} className={selectedDocId === d.id ? "bg-[var(--panel-hover)]" : undefined}>
                    {/* Two caps: the phone cap is what makes the ellipsis render at 390px.
                        Without it the title column takes its natural width, the row scrolls,
                        and the pinned Actions cell slices the title mid-word — the title then
                        reads as corrupted data rather than as text that continues. */}
                    <AdminTd primary truncate="max-w-[190px] sm:max-w-[460px]">
                      {/* `block truncate` on the button itself: an inline-block child of a
                          truncating wrapper is an atomic box and would clip mid-glyph. */}
                      <button
                        type="button"
                        className={cn("block truncate rounded text-left hover:underline", ADMIN_FOCUS_RING)}
                        onClick={() => openDetails(d.id)}
                        title={d.title ?? "Open document details"}
                      >
                        {d.title ?? ADMIN_DASH}
                      </button>
                    </AdminTd>
                    <AdminTd>
                      {(() => {
                        const st = docState(d.status, d.isArchived);
                        return st.tone ? (
                          <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        ) : (
                          <span className="text-[var(--muted-2)]">{st.label}</span>
                        );
                      })()}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      <TimeCell value={d.updatedDate} />
                    </AdminTd>
                    <AdminTd>
                      <IdCell
                        value={d.shareId}
                        label="share id"
                        head={8}
                        tail={4}
                      />
                    </AdminTd>
                    <AdminTd>
                      <IdCell value={d.id} label="doc id" href={`/a/shareviews/${encodeURIComponent(d.id)}`} />
                    </AdminTd>
                    <AdminTd align="right" sticky actions>
                      <RowActions>
                        <RowAction title="Open document details" onClick={() => openDetails(d.id)}>
                          Details
                        </RowAction>
                        <RowAction
                          tone="danger"
                          busy={deleteBusyDocId === d.id}
                          busyLabel="Deleting…"
                          disabled={Boolean(deleteBusyDocId) && deleteBusyDocId !== d.id}
                          title="Soft delete doc"
                          onClick={() => void deleteDoc(d.id)}
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

          {selectedDocId ? (
            <aside className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 lg:sticky lg:top-6 lg:max-h-[calc(100svh-80px)] lg:overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Document details</div>
                  <div className="mt-1 break-all font-mono text-[11px] text-[var(--muted-2)]">{selectedDocId}</div>
                </div>
                <RowActions>
                  <RowAction
                    title="Reload this document"
                    disabled={detailsLoading}
                    onClick={() => void loadDocDetails(selectedDocId)}
                  >
                    {detailsLoading ? "Loading…" : "Refresh"}
                  </RowAction>
                  <RowAction
                    title="Close details"
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
                  </RowAction>
                </RowActions>
              </div>

              {/* No link into the document: admin sees metadata, never someone's file. */}
              <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">{ADMIN_NO_CONTENT_NOTE}</p>

              {detailsError ? (
                <AdminAlert className="mt-3">
                  {detailsError}
                </AdminAlert>
              ) : null}

              {detailsLoading && !docDetails ? (
                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-8 text-center text-[13px] text-[var(--muted-2)]">
                  Loading document…
                </div>
              ) : docDetails?.doc ? (
                <>
                  <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Key fields</div>
                    <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                      <dt className="text-[var(--muted-2)]">status</dt>
                      <dd>
                        {docDetails.doc.status ? (
                          <StatusPill tone={pipelineStatusTone(String(docDetails.doc.status))}>
                            {String(docDetails.doc.status)}
                          </StatusPill>
                        ) : (
                          <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                        )}
                      </dd>
                      <dt className="text-[var(--muted-2)]">currentUploadId</dt>
                      <dd className="break-all font-mono text-[var(--fg)]">
                        {String(docDetails.doc.currentUploadId ?? docDetails.doc.uploadId ?? ADMIN_DASH)}
                      </dd>
                      <dt className="text-[var(--muted-2)]">Preview image</dt>
                      <dd>
                        {docDetails.doc.content?.hasPreviewImage || docDetails.doc.content?.hasFirstPagePng ? (
                          <StatusPill tone="quiet">Stored</StatusPill>
                        ) : (
                          <StatusPill tone="danger">Missing</StatusPill>
                        )}
                      </dd>
                    </dl>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Uploads</div>
                    {Array.isArray(docDetails.uploads) && docDetails.uploads.length ? (
                      <>
                        <div className="mt-1 text-[12px] leading-5 text-[var(--muted-2)]">
                          Latest {Math.min(5, docDetails.uploads.length)} of {docDetails.uploads.length}
                        </div>
                        {/* The shared table, not a hand-rolled one: same density, same header
                            metrics, and a header a screen reader can read out ("Version", not "v"). */}
                        <AdminTable
                          className="mt-2"
                          ariaLabel="Uploads for this document"
                          head={
                            <>
                              <AdminTh align="right" width="w-[70px]">Version</AdminTh>
                              <AdminTh>Status</AdminTh>
                              <AdminTh>Preview</AdminTh>
                              <AdminTh align="right" sticky>Actions</AdminTh>
                            </>
                          }
                        >
                          {docDetails.uploads.slice(0, 5).map((u) => {
                            const hasPreview = Boolean(u.previewImageUrl || u.firstPagePngUrl);
                            const errMsg =
                              u.error && typeof u.error === "object" && (u.error as { message?: unknown }).message
                                ? String((u.error as { message?: unknown }).message)
                                : "";
                            return (
                              <AdminTr key={u.id} className={selectedUploadId === u.id ? "bg-[var(--panel-hover)]" : undefined}>
                                <AdminTd align="right" numeric>
                                  {typeof u.version === "number" ? u.version : ADMIN_DASH}
                                </AdminTd>
                                <AdminTd>
                                  {u.status ? (
                                    <StatusPill tone={pipelineStatusTone(u.status)} title={errMsg || undefined}>
                                      {u.status}
                                    </StatusPill>
                                  ) : (
                                    <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                                  )}
                                </AdminTd>
                                <AdminTd>
                                  {hasPreview ? (
                                    <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                                  ) : (
                                    <StatusPill tone="danger">Missing</StatusPill>
                                  )}
                                </AdminTd>
                                <AdminTd align="right" sticky actions>
                                  <RowActions>
                                    <RowAction
                                      title={errMsg || "Open upload JSON"}
                                      onClick={() => {
                                        setSelectedUploadId(u.id);
                                        void loadUploadDetails(u.id);
                                      }}
                                    >
                                      JSON
                                    </RowAction>
                                  </RowActions>
                                </AdminTd>
                              </AdminTr>
                            );
                          })}
                        </AdminTable>
                      </>
                    ) : (
                      <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-6 text-center text-[12px] text-[var(--muted-2)]">
                        No uploads for this document yet.
                      </div>
                    )}
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Document JSON</div>
                      <RowAction
                        disabled={!docDetails?.doc}
                        title="Copy the document record"
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
                      </RowAction>
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                      {JSON.stringify(docDetails.doc, null, 2)}
                    </pre>
                  </div>

                  {selectedUploadId ? (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Upload JSON</div>
                        <RowActions>
                          <RowAction
                            disabled={!uploadDetails?.upload}
                            title="Copy the upload record"
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
                          </RowAction>
                          <RowAction
                            title="Clear the selected upload"
                            onClick={() => {
                              setSelectedUploadId("");
                              setUploadDetails(null);
                              setUploadDetailsError(null);
                            }}
                          >
                            Clear
                          </RowAction>
                        </RowActions>
                      </div>

                      {uploadDetailsError ? (
                        <AdminAlert className="mt-2">
                          {uploadDetailsError}
                        </AdminAlert>
                      ) : null}
                      {uploadDetailsLoading && !uploadDetails ? (
                        <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-6 text-center text-[12px] text-[var(--muted-2)]">
                          Loading upload…
                        </div>
                      ) : uploadDetails?.upload ? (
                        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                          {JSON.stringify(uploadDetails.upload, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-8 text-center">
                  <div className="text-[13px] font-medium text-[var(--fg)]">Nothing loaded for this document</div>
                  <div className="mt-1 text-[12px] text-[var(--muted-2)]">Refresh, or pick another row from the list.</div>
                </div>
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
