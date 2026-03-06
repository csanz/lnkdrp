/**
 * Admin route: `/a/data/uploads`
 *
 * Lists uploads across all users for admin inspection (paged).
 */
"use client";

import { useSearchParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { Suspense, useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type UploadRow = {
  id: string;
  userId: string | null;
  docId: string | null;
  docTitle: string | null;
  shareId: string | null;
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

export default function AdminDataUploadsPage() {
  return (
    <Suspense>
      <AdminDataUploadsPageInner />
    </Suspense>
  );
}

function AdminDataUploadsPageInner() {
  const searchParams = useSearchParams();
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

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

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

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Uploads</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/uploads" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Uploads</div>
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
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Uploads</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of uploads across all users.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search filename or doc title…"
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

        <div className={["mt-6 grid gap-5", selectedUploadId ? "lg:grid-cols-[1fr_520px]" : ""].join(" ")}>
          <div className="min-w-0">
            {loading ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                Loading…
              </div>
            ) : (
              <DataTable>
                <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
                  <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    <th className="px-4 py-3">File</th>
                    <th className="px-4 py-3">Doc</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Version</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">User ID</th>
                    <th className="px-4 py-3">Upload ID</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {items.map((u) => (
                    <tr key={u.id} className={selectedUploadId === u.id ? "bg-[var(--panel-2)]/60" : ""}>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => {
                            setSelectedUploadId(u.id);
                            void loadUploadDetails(u.id);
                          }}
                          title="Open upload details"
                        >
                          {u.originalFileName ?? "—"}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <div className="truncate">{u.docTitle ?? u.docId ?? "—"}</div>
                          {u.shareId ? (
                            <a
                              className="mt-1 inline-block text-xs text-[var(--muted)] hover:underline"
                              href={`/s/${encodeURIComponent(u.shareId)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              /s/{u.shareId}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">{u.status ?? "—"}</td>
                      <td className="px-4 py-3">{typeof u.version === "number" ? u.version : "—"}</td>
                      <td className="px-4 py-3">{fmtDate(u.createdDate) || "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{u.userId ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{u.id}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                            onClick={() => {
                              setSelectedUploadId(u.id);
                              void loadUploadDetails(u.id);
                            }}
                          >
                            Details
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-red-500 hover:bg-[var(--panel-hover)] disabled:opacity-60"
                            disabled={Boolean(deleteBusyUploadId) && deleteBusyUploadId !== u.id}
                            onClick={() => void deleteUpload(u.id)}
                          >
                            {deleteBusyUploadId === u.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                        No uploads.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </DataTable>
            )}
          </div>

          {selectedUploadId ? (
            <aside className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 lg:sticky lg:top-6 lg:max-h-[calc(100svh-80px)] lg:overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--fg)]">Upload details</div>
                  <div className="mt-1 font-mono text-xs text-[var(--muted)] break-all">{selectedUploadId}</div>
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                  onClick={() => {
                    setSelectedUploadId("");
                    setUploadDetails(null);
                    setDetailsError(null);
                  }}
                >
                  Close
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-60"
                  disabled={detailsLoading}
                  onClick={() => void loadUploadDetails(selectedUploadId)}
                >
                  {detailsLoading ? "Loading…" : "Refresh"}
                </button>
                {uploadDetails?.upload?.docId ? (
                  <a
                    className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs font-semibold hover:bg-[var(--panel-hover)]"
                    href={`/doc/${encodeURIComponent(String(uploadDetails.upload.docId))}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open /doc
                  </a>
                ) : null}
              </div>

              {detailsError ? (
                <Alert variant="info" className="mt-3 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
                  {detailsError}
                </Alert>
              ) : null}

              {detailsLoading && !uploadDetails ? (
                <div className="mt-3 text-sm text-[var(--muted)]">Loading upload JSON…</div>
              ) : uploadDetails?.upload ? (
                <>
                  <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Preview / error</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div className="text-[var(--muted)]">previewImageUrl</div>
                      <div className={["font-mono break-all", uploadDetails.upload.previewImageUrl ? "text-[var(--fg)]" : "text-red-500"].join(" ")}>
                        {String(uploadDetails.upload.previewImageUrl ?? uploadDetails.upload.firstPagePngUrl ?? "null")}
                      </div>
                      <div className="text-[var(--muted)]">error.message</div>
                      <div className="font-mono text-[var(--fg)] break-all">
                        {String(uploadDetails.upload.error?.message ?? "—")}
                      </div>
                      <div className="text-[var(--muted)]">error.details.preview</div>
                      <div className="font-mono text-[var(--fg)] break-all">
                        {String(uploadDetails.upload.error?.details?.preview ?? "—")}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Upload JSON</div>
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
                    </div>
                    <pre className="mt-2 max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[11px] text-[var(--fg)]">
                      {JSON.stringify(uploadDetails.upload, null, 2)}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="mt-3 text-sm text-[var(--muted)]">Select an upload to view details.</div>
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}




