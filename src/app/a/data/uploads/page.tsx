/**
 * Admin route: `/a/data/uploads`
 *
 * Lists uploads across all users for admin inspection (paged), with a detail drawer carrying
 * the raw upload record. Built on the shared admin UI in `@/components/admin` — see
 * `/a/data/users` for the reference implementation.
 */
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
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
  IdCell,
  RowAction,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_NO_CONTENT_NOTE, ADMIN_NO_SECRETS_NOTE } from "@/lib/admin/docPrivacy";
import { ADMIN_DASH, ADMIN_FOCUS_RING, statusLabel } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { pipelineStatusTone } from "@/lib/admin/statusTones";
import { fetchJson } from "@/lib/http/fetchJson";

type UploadRow = {
  id: string;
  userId: string | null;
  docId: string | null;
  docTitle: string | null;
  originalFileName: string | null;
  version: number | null;
  status: string | null;
  createdDate: string | null;
};

type AdminUploadDetailsResponse = {
  ok?: boolean;
  upload?: any;
  error?: string;
};

/** Column count of the table below; every full-width row's colSpan has to match it. */
const COLUMN_COUNT = 7;

/** Route entry: the uploads list reads `?uploadId=`, so it renders inside a Suspense boundary. */
export default function AdminDataUploadsPage() {
  return (
    <Suspense>
      <AdminDataUploadsPageInner />
    </Suspense>
  );
}

/** The Uploads browser: every uploaded file, with a detail drawer carrying the raw record. */
function AdminDataUploadsPageInner() {
  const searchParams = useSearchParams();
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBusyUploadId, setDeleteBusyUploadId] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedUploadId, setSelectedUploadId] = useState<string>("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [uploadDetails, setUploadDetails] = useState<AdminUploadDetailsResponse | null>(null);
  const [uploadJsonCopyDone, setUploadJsonCopyDone] = useState(false);

  /** A search narrowing the list — decides which empty-state sentence the table shows. */
  const filtered = Boolean(q.trim());

  /** Best-effort clipboard write; returns false when the browser refuses. */
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Load one upload's raw record into the detail drawer. */
  async function loadUploadDetails(uploadId: string) {
    if (!uploadId) return;
    setDetailsLoading(true);
    setDetailsError(null);
    setUploadDetails(null);
    setUploadJsonCopyDone(false);
    try {
      const data = await fetchJson<AdminUploadDetailsResponse>(`/api/admin/data/uploads/${encodeURIComponent(uploadId)}`, {
        method: "GET",
      });
      setUploadDetails(data);
    } catch (e) {
      setDetailsError(e instanceof Error ? e.message : "Failed to load upload details");
    } finally {
      setDetailsLoading(false);
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
        const data = await fetchJson<{ uploads?: unknown; total?: unknown }>(`/api/admin/data/uploads?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.uploads) ? (data.uploads as UploadRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load uploads");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, reloadKey]);

  useEffect(() => {
    if (!canUseAdmin) return;
    const fromUrl = (searchParams?.get("uploadId") ?? "").trim();
    if (!fromUrl) return;
    if (fromUrl === selectedUploadId) return;
    setSelectedUploadId(fromUrl);
    void loadUploadDetails(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseAdmin, searchParams]);

  /** Soft-delete an upload, then drop its row optimistically. */
  async function deleteUpload(uploadId: string) {
    if (!uploadId) return;
    if (deleteBusyUploadId) return;
    const ok = window.confirm(`Soft-delete upload ${uploadId}?\n\nThis can break doc history; use with care.`);
    if (!ok) return;
    setDeleteBusyUploadId(uploadId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((u) => u.id !== uploadId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete upload");
    } finally {
      setDeleteBusyUploadId("");
    }
  }

  /** Select a row and open the detail drawer on it. */
  function openDetails(uploadId: string) {
    setSelectedUploadId(uploadId);
    void loadUploadDetails(uploadId);
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Uploads" description="Every uploaded file across all users, with the record behind each one." callbackUrl="/a/data/uploads" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Uploads" description="Every uploaded file across all users, with the record behind each one." />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="uploads"
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
            placeholder="Search filename or doc title…"
            ariaLabel="Search uploads by filename or document title"
          />
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <div className={["mt-3 grid gap-4", selectedUploadId ? "lg:grid-cols-[1fr_480px]" : ""].join(" ")}>
          <div className="min-w-0">
            <AdminTable
              ariaLabel="Uploads"
              head={
                <>
                  {/* File is the identity and takes the slack; the two ids sit last. */}
                  <AdminTh>File</AdminTh>
                  <AdminTh>Document</AdminTh>
                  <AdminTh width="w-[110px]">Status</AdminTh>
                  <AdminTh align="right" width="w-[70px]">Version</AdminTh>
                  <AdminTh align="right" width="w-[130px]">Created</AdminTh>
                  <AdminTh width="w-[130px]">Upload ID</AdminTh>
                  <AdminTh align="right" sticky>
                    Actions
                  </AdminTh>
                </>
              }
            >
              {loading && items.length === 0 ? (
                <AdminTableMessage colSpan={COLUMN_COUNT}>Loading uploads…</AdminTableMessage>
              ) : items.length === 0 ? (
                <AdminTableEmpty
                  colSpan={COLUMN_COUNT}
                  title={filtered ? "No uploads match that search" : "No uploads yet"}
                  hint={filtered ? "Try a different filename or document title." : undefined}
                />
              ) : (
                items.map((u) => (
                  <AdminTr key={u.id} className={selectedUploadId === u.id ? "bg-[var(--panel-hover)]" : undefined}>
                    {/* The phone cap is what makes the ellipsis render at 390px: uncapped, the
                        column takes its natural width and the pinned Actions cell slices the
                        filename mid-word with no "…". */}
                    <AdminTd primary truncate="max-w-[170px] sm:max-w-[250px]">
                      {/* `block truncate` on the button: an inline-block child of a truncating
                          wrapper is an atomic box and would be sliced mid-glyph with no "…". */}
                      <button
                        type="button"
                        className={cn("block truncate rounded text-left hover:underline", ADMIN_FOCUS_RING)}
                        onClick={() => openDetails(u.id)}
                        title={u.originalFileName ?? "Open upload details"}
                      >
                        {u.originalFileName ?? ADMIN_DASH}
                      </button>
                    </AdminTd>
                    <AdminTd truncate="max-w-[160px] sm:max-w-[210px]">
                      {u.docId ? (
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(u.docId)}`}
                          className={cn("block truncate rounded hover:underline", ADMIN_FOCUS_RING)}
                          title={u.docTitle ?? u.docId}
                        >
                          {u.docTitle ?? u.docId}
                        </Link>
                      ) : (
                        <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      )}
                    </AdminTd>
                    <AdminTd>
                      {/* A pill on every row is decoration: the happy path is a plain word,
                          and only a status worth acting on gets a chip. */}
                      {!u.status ? (
                        <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      ) : pipelineStatusTone(u.status) === "quiet" ? (
                        <span className="text-[var(--muted-2)]">{statusLabel(u.status)}</span>
                      ) : (
                        <StatusPill tone={pipelineStatusTone(u.status)}>{u.status}</StatusPill>
                      )}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {typeof u.version === "number" ? u.version : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      <TimeCell value={u.createdDate} />
                    </AdminTd>
                    <AdminTd>
                      <IdCell value={u.id} label="upload id" />
                    </AdminTd>
                    <AdminTd align="right" sticky actions>
                      <RowActions>
                        <RowAction title="Open upload details" onClick={() => openDetails(u.id)}>
                          Details
                        </RowAction>
                        <RowAction
                          tone="danger"
                          busy={deleteBusyUploadId === u.id}
                          busyLabel="Deleting…"
                          disabled={Boolean(deleteBusyUploadId) && deleteBusyUploadId !== u.id}
                          title="Soft delete upload"
                          onClick={() => void deleteUpload(u.id)}
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

          {selectedUploadId ? (
            <aside className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 lg:sticky lg:top-6 lg:max-h-[calc(100svh-80px)] lg:overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Upload details</div>
                  <div className="mt-1 break-all font-mono text-[11px] text-[var(--muted-2)]">{selectedUploadId}</div>
                </div>
                <RowActions>
                  <RowAction
                    title="Reload this upload"
                    disabled={detailsLoading}
                    onClick={() => void loadUploadDetails(selectedUploadId)}
                  >
                    {detailsLoading ? "Loading…" : "Refresh"}
                  </RowAction>
                  <RowAction
                    title="Close details"
                    onClick={() => {
                      setSelectedUploadId("");
                      setUploadDetails(null);
                      setDetailsError(null);
                    }}
                  >
                    Close
                  </RowAction>
                </RowActions>
              </div>

              {uploadDetails?.upload?.docId ? (
                <div className="mt-3">
                  <span className="text-[12px] text-[var(--muted-2)]">{ADMIN_NO_CONTENT_NOTE}</span>
                  <span className="mt-1 block text-[12px] text-[var(--muted-2)]">{ADMIN_NO_SECRETS_NOTE}</span>
                </div>
              ) : null}

              {detailsError ? (
                <AdminAlert className="mt-3">
                  {detailsError}
                </AdminAlert>
              ) : null}

              {detailsLoading && !uploadDetails ? (
                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-8 text-center text-[13px] text-[var(--muted-2)]">
                  Loading upload…
                </div>
              ) : uploadDetails?.upload ? (
                <>
                  <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Preview and error</div>
                    <dl className="mt-2 grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                      <dt className="text-[var(--muted-2)]">previewImageUrl</dt>
                      <dd className="break-all font-mono">
                        {uploadDetails.upload.previewImageUrl || uploadDetails.upload.firstPagePngUrl ? (
                          <span className="text-[var(--fg)]">
                            {String(uploadDetails.upload.previewImageUrl ?? uploadDetails.upload.firstPagePngUrl)}
                          </span>
                        ) : (
                          <StatusPill tone="danger">Missing</StatusPill>
                        )}
                      </dd>
                      <dt className="text-[var(--muted-2)]">error.message</dt>
                      <dd className="break-all font-mono text-[var(--fg)]">
                        {String(uploadDetails.upload.error?.message ?? ADMIN_DASH)}
                      </dd>
                      <dt className="text-[var(--muted-2)]">error.details.preview</dt>
                      <dd className="break-all font-mono text-[var(--fg)]">
                        {String(uploadDetails.upload.error?.details?.preview ?? ADMIN_DASH)}
                      </dd>
                    </dl>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)]">Upload JSON</div>
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
                    </div>
                    <pre className="mt-2 max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                      {JSON.stringify(uploadDetails.upload, null, 2)}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-8 text-center">
                  <div className="text-[13px] font-medium text-[var(--fg)]">Nothing loaded for this upload</div>
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
