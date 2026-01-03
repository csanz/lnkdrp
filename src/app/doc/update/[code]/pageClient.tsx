"use client";

// Public doc update page (upload a new version for an existing doc). Route: /doc/update/:code

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpTrayIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname } from "@/lib/blob/clientUpload";
import { extractErrorMessage, fetchJson } from "@/lib/http/fetchJson";

type DocMeta = {
  id: string;
  title: string;
  shareId: string | null;
  previewImageUrl: string | null;
  currentVersion: number | null;
};

type GetDocUpdateMetaResponse = {
  doc: DocMeta;
};

type StartReplaceUploadResponse = {
  doc: { id: string };
  upload: { id: string; secret: string };
};

type UploadStatusResponse = {
  upload: { id: string; docId: string | null; status: string | null };
  doc: { id: string | null; status: string | null };
};

function isAcceptedPdfOrImage(file: File) {
  const t = (file.type || "").toLowerCase();
  return t === "application/pdf" || t.startsWith("image/");
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : i === 1 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export default function DocUpdatePageClient(props: { code: string }) {
  const code = useMemo(() => (props.code || "").trim(), [props.code]);

  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    | { step: "idle" }
    | { step: "starting" }
    | { step: "uploading" }
    | { step: "finalizing" }
    | { step: "processing" }
    | { step: "done" }
  >({ step: "idle" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const accept = useMemo(() => "application/pdf,image/*", []);
  const statusLabel = useMemo(() => {
    return status.step === "starting"
      ? "Starting upload…"
      : status.step === "uploading"
        ? "Uploading file…"
        : status.step === "finalizing"
          ? "Finalizing…"
          : status.step === "processing"
            ? "Processing…"
            : status.step === "done"
              ? "Done"
              : "Ready";
  }, [status.step]);

  useEffect(() => {
    if (!code) {
      setMetaError("Invalid link.");
      return;
    }
    let cancelled = false;
    setMetaLoading(true);
    setMetaError(null);
    void (async () => {
      try {
        const json = await fetchJson<GetDocUpdateMetaResponse>(`/api/doc/update/${encodeURIComponent(code)}`, {
          method: "GET",
          cache: "no-store",
        });
        if (cancelled) return;
        setDoc(json.doc);
      } catch (e) {
        if (cancelled) return;
        setMetaError(e instanceof Error ? e.message : "Failed to load document details.");
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function fetchJsonDirect<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const message = extractErrorMessage(data) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data as T;
  }

  async function startUpload() {
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      if (!code) throw new Error("Invalid link.");
      if (!file) throw new Error("Choose a file to upload.");
      if (!isAcceptedPdfOrImage(file)) throw new Error("Please upload a PDF or an image.");

      setStatus({ step: "starting" });
      const init = await fetchJsonDirect<StartReplaceUploadResponse>(`/api/doc/update/${encodeURIComponent(code)}/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originalFileName: file.name,
          contentType: file.type || null,
          sizeBytes: file.size,
        }),
      });

      const docId = init.doc.id;
      const uploadId = init.upload.id;
      const uploadSecret = init.upload.secret;

      const pathname = buildDocBlobPathname({
        docId,
        uploadId,
        fileName: file.name,
      });

      setStatus({ step: "uploading" });
      const blob = await blobUpload(pathname, file, {
        access: "public",
        handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
        contentType: file.type || undefined,
      });

      setStatus({ step: "finalizing" });
      await fetchJsonDirect(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-upload-secret": uploadSecret,
        },
        body: JSON.stringify({
          status: "uploaded",
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          metadata: { size: file.size },
        }),
      });

      setStatus({ step: "processing" });
      await fetchJsonDirect(`/api/uploads/${encodeURIComponent(uploadId)}/process`, {
        method: "POST",
        headers: { "x-upload-secret": uploadSecret },
      });

      const startedAt = Date.now();
      const maxWaitMs = 5 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() - startedAt > maxWaitMs) {
          throw new Error("Still processing. Please keep this tab open a bit longer and try again.");
        }

        const st = await fetchJsonDirect<UploadStatusResponse>(`/api/uploads/${encodeURIComponent(uploadId)}`, {
          method: "GET",
          headers: { "x-upload-secret": uploadSecret },
        });
        const uploadStatus = (st.upload?.status ?? "").toLowerCase();
        const docStatus = (st.doc?.status ?? "").toLowerCase();
        if (uploadStatus === "failed" || docStatus === "failed") {
          throw new Error("Processing failed. Please try uploading again.");
        }
        if (docStatus === "ready") break;
        await new Promise((r) => setTimeout(r, 1200));
      }

      setStatus({ step: "done" });
      setDone(true);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Upload failed";
      setError(raw);
      setStatus({ step: "idle" });
    } finally {
      setBusy(false);
    }
  }

  const shareHref = useMemo(() => {
    const shareId = doc?.shareId ?? null;
    if (!shareId) return null;
    return `/s/${encodeURIComponent(shareId)}`;
  }, [doc?.shareId]);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 py-10">
      <div className="mb-6 flex items-center justify-center">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
          aria-label="Lnkdrp home"
          title="Lnkdrp"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-white.svg" alt="" className="h-5 w-5" />
          <span className="tracking-tight">lnkdrp</span>
        </Link>
      </div>
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Document update</div>
        <div className="mt-2 text-xl font-semibold text-[var(--fg)]">Update this document with a new version</div>
        <div className="mt-2 text-sm text-[var(--muted)]">
          You’re replacing the current file. The owner will see a new version in the document history.
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-[140px_1fr]">
          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]">
            {doc?.previewImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={doc.previewImageUrl} alt="Document preview" className="h-[180px] w-full object-contain" />
            ) : (
              <div className="grid h-[180px] place-items-center">
                <DocumentTextIcon className="h-10 w-10 text-[var(--muted-2)]" aria-hidden="true" />
              </div>
            )}
          </div>

          <div className="min-w-0">
            {metaLoading ? (
              <div className="text-sm text-[var(--muted)]">Loading document details…</div>
            ) : metaError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900 dark:border-red-300/25 dark:bg-red-300/10 dark:text-red-200">
                <div className="text-sm font-semibold">Can’t load document</div>
                <div className="mt-1 text-sm opacity-90">{metaError}</div>
              </div>
            ) : doc ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 truncate text-base font-semibold text-[var(--fg)]">{doc.title}</div>
                  {doc.currentVersion != null ? (
                    <span className="inline-flex items-center rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted-2)]">
                      v{doc.currentVersion}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {shareHref ? (
                    <Link
                      href={shareHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                    >
                      View current document
                    </Link>
                  ) : (
                    <div className="text-sm text-[var(--muted)]">Share link not available.</div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-[var(--muted)]">Document details not available.</div>
            )}
          </div>
        </div>

        <div className="mt-8">
          <label className="block text-sm font-medium text-[var(--fg)]">Upload new version</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setDone(false);
                setError(null);
                setStatus({ step: "idle" });
              }}
              className="block w-full text-sm text-[var(--fg)] file:mr-4 file:rounded-xl file:border-0 file:bg-[var(--panel-hover)] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[var(--fg)] hover:file:bg-[var(--panel)]"
            />
            <button
              type="button"
              onClick={() => void startUpload()}
              disabled={busy || !file}
              className={[
                "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold",
                busy || !file
                  ? "cursor-not-allowed border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]"
                  : "bg-black text-white hover:bg-black/90",
              ].join(" ")}
            >
              <ArrowUpTrayIcon className="h-4 w-4" aria-hidden="true" />
              {busy ? statusLabel : "Upload update"}
            </button>
          </div>
          {file ? (
            <div className="mt-2 text-xs text-[var(--muted)]">
              Selected: <span className="font-medium text-[var(--fg)]">{file.name}</span>{" "}
              {file.size ? <span>({formatBytes(file.size)})</span> : null}
            </div>
          ) : null}
        </div>

        {busy ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="text-sm font-semibold text-[var(--fg)]">{statusLabel}</div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
              <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
            </div>
            <div className="mt-2 text-xs text-[var(--muted)]">Keep this tab open until processing finishes.</div>
          </div>
        ) : null}

        {done ? (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-300/25 dark:bg-emerald-300/10 dark:text-emerald-200">
            <div className="text-sm font-semibold">Update uploaded</div>
            <div className="mt-1 text-sm opacity-90">You can close this tab now.</div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900 dark:border-red-300/25 dark:bg-red-300/10 dark:text-red-200">
            <div className="text-sm font-semibold">Upload failed</div>
            <div className="mt-1 text-sm opacity-90">{error}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


