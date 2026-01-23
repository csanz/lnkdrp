"use client";

// Public request upload page (responders upload into a request repo). Route: /r/:token (legacy alias for /request/:token)
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpTrayIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname, buildDocPreviewPngPathname } from "@/lib/blob/clientUpload";
import { fetchJson } from "@/lib/http/fetchJson";
import { BOT_ID_HEADER, getOrCreateBotId } from "@/lib/botId";
import { useAuthEnabled } from "@/app/providers";
import { useSession } from "next-auth/react";
import { StandaloneBrandedHeader } from "@/components/StandaloneBrandedHeader";

type LocalUploadPreviewStored = {
  token: string;
  updatedAt: string; // ISO
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  /** Public blob URL returned from the client upload (preferred preview source). */
  blobUrl?: string;
  /**
   * Optional inline preview as a Data URL (best-effort).
   * Only stored for small files to avoid exceeding browser storage limits.
   */
  dataUrl?: string;
  /**
   * Indicates the user successfully completed an upload flow for this file.
   * (We still store selection previews even if upload hasn't been submitted yet.)
   */
  uploaded?: boolean;
};

type StartRequestUploadResponse = {
  doc: { id: string };
  upload: { id: string; secret: string };
};

type UploadStatusResponse = {
  upload: { id: string; docId: string | null; status: string | null };
  doc: { id: string | null; status: string | null };
};
/**
 * Return whether accepted pdf or image.
 */

function isAcceptedPdfOrImage(file: File) {
  const t = (file.type || "").toLowerCase();
  return t === "application/pdf" || t.startsWith("image/");
}

async function renderPdfFirstPagePngBestEffort(file: File): Promise<Blob | null> {
  try {
    const ct = (file.type || "").toLowerCase();
    if (ct !== "application/pdf") return null;

    // Use the already-selected file bytes to avoid any CORS complications.
    const pdfBytes = new Uint8Array(await file.arrayBuffer());

    // Load PDF.js from our vendored ESM bundle in /public (same approach as PdfJsViewer).
    const pdfjsModuleUrl = "/pdfjs/pdf.min.mjs";
    const pdfjs = (await import(/* webpackIgnore: true */ pdfjsModuleUrl)) as any;

    // Preview rendering is best-effort; disable worker for maximum compatibility.
    const loadingTask = pdfjs.getDocument({ data: pdfBytes, disableWorker: true });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);

    const scale = 2;
    const maxWidth = 1200;
    const baseViewport = page.getViewport({ scale });
    const finalScale = baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
    const viewport = page.getViewport({ scale: finalScale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });

    try {
      await pdf.destroy?.();
    } catch {
      // ignore
    }

    return pngBlob;
  } catch {
    return null;
  }
}
/**
 * Format Bytes (uses isFinite, toFixed).
 */


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

function localPreviewStorageKey(token: string): string {
  return `lnkdrp_request_upload_preview:${token}`;
}

function safeReadLocalPreview(token: string): LocalUploadPreviewStored | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(localPreviewStorageKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<LocalUploadPreviewStored>;
    if (p.token !== token) return null;
    if (typeof p.fileName !== "string" || !p.fileName) return null;
    if (typeof p.sizeBytes !== "number" || !Number.isFinite(p.sizeBytes)) return null;
    if (typeof p.updatedAt !== "string" || !p.updatedAt) return null;
    if (p.contentType !== null && typeof p.contentType !== "string") return null;
    if (typeof p.blobUrl !== "undefined" && typeof p.blobUrl !== "string") return null;
    if (typeof p.dataUrl !== "undefined" && typeof p.dataUrl !== "string") return null;
    if (typeof p.uploaded !== "undefined" && typeof p.uploaded !== "boolean") return null;
    return {
      token,
      updatedAt: p.updatedAt,
      fileName: p.fileName,
      contentType: p.contentType ?? null,
      sizeBytes: p.sizeBytes,
      ...(p.blobUrl ? { blobUrl: p.blobUrl } : {}),
      ...(p.dataUrl ? { dataUrl: p.dataUrl } : {}),
      ...(typeof p.uploaded === "boolean" ? { uploaded: p.uploaded } : {}),
    };
  } catch {
    return null;
  }
}

function safeWriteLocalPreview(token: string, next: LocalUploadPreviewStored): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localPreviewStorageKey(token), JSON.stringify(next));
  } catch {
    // ignore storage failures (quota/private mode/etc)
  }
}

function safeClearLocalPreview(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(localPreviewStorageKey(token));
  } catch {
    // ignore
  }
}

async function fileToDataUrlBestEffort(file: File): Promise<string | null> {
  // Avoid blowing localStorage (which is usually ~5MB total per origin).
  // Base64 adds ~33%, so keep raw size fairly small.
  const MAX_BYTES_FOR_DATA_URL = 1_000_000; // 1.0MB
  if (!Number.isFinite(file.size) || file.size <= 0) return null;
  if (file.size > MAX_BYTES_FOR_DATA_URL) return null;

  return await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onerror = () => resolve(null);
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
    fr.readAsDataURL(file);
  });
}
/**
 * Render the RequestUploadPageClient UI (uses memoized values, local state).
 */


export default function RequestUploadPageClient(props: {
  token: string;
  requestName: string;
  requestDescription: string;
  requireAuthToUpload: boolean;
}) {
  const { token, requestName, requestDescription, requireAuthToUpload } = props;
  const [file, setFile] = useState<File | null>(null);
  const [savedPreview, setSavedPreview] = useState<LocalUploadPreviewStored | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
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
  const showSuccess = useMemo(() => !busy && (done || Boolean(savedPreview?.uploaded)), [busy, done, savedPreview?.uploaded]);
  const statusLabel = useMemo(() => {
    return status.step === "starting"
      ? "Starting upload…"
      : status.step === "uploading"
        ? "Uploading file…"
        : status.step === "finalizing"
          ? "Finalizing…"
          : status.step === "processing"
            ? "Processing your upload (including AI)…"
            : status.step === "done"
              ? "Done"
              : "Working…";
  }, [status.step]);

  useEffect(() => {
    setSavedPreview(safeReadLocalPreview(token));
  }, [token]);

  useEffect(() => {
    if (!busy) return;
    // Discourage leaving mid-upload/processing (refresh/close/navigate away).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Most browsers ignore custom text, but setting returnValue triggers the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);
/**
   * Set next file.
   */


  function setNextFile(f: File | null) {
    setFile(f);
    setDone(false);
    setError(null);
    setStatus({ step: "idle" });
    // Also persist the user's selection so revisiting the link shows a preview.
    if (!f) return;
    void (async () => {
      const dataUrl = await fileToDataUrlBestEffort(f);
      const next: LocalUploadPreviewStored = {
        token,
        updatedAt: new Date().toISOString(),
        fileName: f.name,
        contentType: f.type || null,
        sizeBytes: f.size,
        ...(dataUrl ? { dataUrl } : {}),
        uploaded: false,
      };
      safeWriteLocalPreview(token, next);
      setSavedPreview(next);
    })();
  }
/**
 * Start Upload (updates state (setBusy, setDone, setError); uses setBusy, setDone, setError).
 */


  async function startUpload() {
    setBusy(true);
    setDone(false);
    setError(null);
    let blobUrl: string | null = null;
    try {
      if (!file) throw new Error("Choose a file to upload.");
      if (!isAcceptedPdfOrImage(file)) throw new Error("Please upload a PDF or an image.");

      setStatus({ step: "starting" });
      const init = await fetchJson<StartRequestUploadResponse>(
        `/api/requests/${encodeURIComponent(token)}/uploads`,
        {
          method: "POST",
          headers: (function () {
            const headers: Record<string, string> = {
              "content-type": "application/json",
            };
            // For public request links, we pass a lightweight bot/device id to reduce abuse.
            // For auth-required request links, server-side session auth is used instead.
            if (!requireAuthToUpload) {
              const botId = getOrCreateBotId();
              if (botId) headers[BOT_ID_HEADER] = botId;
            }
            return headers;
          })(),
          body: JSON.stringify({
            originalFileName: file.name,
            contentType: file.type || null,
            sizeBytes: file.size,
          }),
        },
      );

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
      blobUrl = blob.url;

      // Best-effort: generate a server-independent preview PNG for PDFs.
      // This avoids relying on Node-native canvas bindings during processing.
      let previewImageUrl: string | null = null;
      try {
        const pngBlob = await renderPdfFirstPagePngBestEffort(file);
        if (pngBlob) {
          const previewPathname = buildDocPreviewPngPathname({ docId, uploadId });
          const previewFile = new File([pngBlob], "preview.png", { type: "image/png" });
          const preview = await blobUpload(previewPathname, previewFile, {
            access: "public",
            handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
            contentType: "image/png",
          });
          previewImageUrl = preview.url;
        }
      } catch {
        // ignore (best-effort)
      }

      setStatus({ step: "finalizing" });
      await fetchJson(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-upload-secret": uploadSecret,
        },
        body: JSON.stringify({
          status: "uploaded",
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          previewImageUrl,
          metadata: { size: file.size },
        }),
      });

      setStatus({ step: "processing" });
      await fetchJson(`/api/uploads/${encodeURIComponent(uploadId)}/process`, {
        method: "POST",
        headers: { "x-upload-secret": uploadSecret },
      });

      // IMPORTANT: processing continues on the server after /process returns.
      // Keep this tab in "Processing…" until the upload/doc are actually done.
      const startedAt = Date.now();
      const maxWaitMs = 5 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() - startedAt > maxWaitMs) {
          throw new Error(
            "Still processing. Please keep this tab open for a bit longer and try again.",
          );
        }

        const st = await fetchJson<UploadStatusResponse>(
          `/api/uploads/${encodeURIComponent(uploadId)}`,
          {
            method: "GET",
            headers: { "x-upload-secret": uploadSecret },
          },
        );

        const uploadStatus = (st.upload?.status ?? "").toLowerCase();
        const docStatus = (st.doc?.status ?? "").toLowerCase();

        if (uploadStatus === "failed" || docStatus === "failed") {
          throw new Error("Processing failed. Please try uploading again.");
        }

        // We consider the flow complete only once the doc is ready (viewer + intel).
        // Note: upload.status can become "completed" before request-review finishes.
        if (docStatus === "ready") break;

        await new Promise((r) => setTimeout(r, 1200));
      }

      setStatus({ step: "done" });
      setDone(true);
      setFile(null);
      // Mark the saved preview as uploaded (best-effort) so revisit shows it as completed.
      setSavedPreview((prev) => {
        if (!prev || prev.token !== token) return prev;
        const next: LocalUploadPreviewStored = {
          ...prev,
          ...(blobUrl ? { blobUrl } : {}),
          uploaded: true,
          updatedAt: new Date().toISOString(),
        };
        safeWriteLocalPreview(token, next);
        return next;
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Upload failed";
      const msg = raw === "AUTH_REQUIRED" ? "Sign in required to upload to this link." : raw;
      setError(msg);
      setStatus({ step: "idle" });
    } finally {
      setBusy(false);
    }
  }

  function AuthRequiredPanel() {
    const authEnabled = useAuthEnabled();
    if (!requireAuthToUpload) return null;

    if (!authEnabled) {
      return (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-sm font-semibold">Sign-in required</div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            This request link requires authentication to upload, but login is disabled in this environment.
          </div>
        </div>
      );
    }

    return <SignedInGate />;
  }

  function SignedInGate() {
    const { status } = useSession();
    if (status === "loading") {
      return (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-sm font-semibold">Checking sign-in…</div>
          <div className="mt-2 text-sm text-[var(--muted)]">One moment.</div>
        </div>
      );
    }
    if (status !== "authenticated") {
      return (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-sm font-semibold">Sign in to upload</div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            This request link only accepts uploads from authenticated (signed-in) users.
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90"
            >
              Log in
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)]"
            >
              Back
            </Link>
          </div>
        </div>
      );
    }
    return null;
  }

  function AuthenticatedOnly({ children }: { children: ReactNode }) {
    const authEnabled = useAuthEnabled();
    if (!authEnabled) return null;
    return <AuthenticatedOnlyWithSession>{children}</AuthenticatedOnlyWithSession>;
  }

  function AuthenticatedOnlyWithSession({ children }: { children: ReactNode }) {
    const { status } = useSession();
    if (status !== "authenticated") return null;
    return <>{children}</>;
  }

  function UploadControls() {
    return (
      <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="text-sm font-semibold">Upload a file</div>
        <div className="mt-2 text-sm text-[var(--muted)]">
          Drag & drop a PDF or image here, or click to choose a file. Your upload will be added to the requester’s request repository.
        </div>

        <div className="mt-4 grid gap-3">
          {busy ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                Upload status
              </div>
              <div className="mt-2 text-sm text-[var(--fg)]">{statusLabel}</div>
              <div className="mt-1 text-sm text-[var(--muted)]">
                Please keep this tab open — everything happens in this browser session.
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--primary-bg)]" />
              </div>
              <div className="sr-only" aria-live="polite">
                {statusLabel}
              </div>
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0] ?? null;
              setNextFile(f);
            }}
          />

          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (busy) return;
              setDragActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (busy) return;
              setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              if (busy) return;
              const f = e.dataTransfer?.files?.[0] ?? null;
              if (!f) return;
              setNextFile(f);
            }}
            className={[
              "group relative rounded-2xl border-2 border-dashed p-6 text-left transition-colors",
              dragActive
                ? "border-[var(--ring)] bg-[var(--panel-2)]"
                : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)]",
              busy ? "opacity-60" : "",
            ].join(" ")}
            aria-label="Drag and drop a file, or click to choose"
          >
            <div className="flex items-start gap-4">
              <div
                className={[
                  "mt-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl border",
                  "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
                  dragActive ? "ring-2 ring-[var(--ring)]" : "",
                ].join(" ")}
              >
                <ArrowUpTrayIcon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--fg)]">{file ? file.name : "Drop file here"}</div>
                <div className="mt-1 text-sm text-[var(--muted)]">
                  {file ? (
                    <span>
                      {file.type ? file.type : "file"} {file.size ? `• ${formatBytes(file.size)}` : ""}
                    </span>
                  ) : (
                    <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover:decoration-[var(--border)]">
                      Click to choose a file
                    </span>
                  )}
                </div>
              </div>
              {file ? (
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--muted)]">Selected</span>
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
                    <XMarkIcon
                      className="h-4 w-4"
                      aria-hidden="true"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setNextFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                    />
                  </span>
                </div>
              ) : null}
            </div>
          </button>

          <button
            type="button"
            disabled={busy || !file}
            className={[
              "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold",
              "bg-black text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-50",
            ].join(" ")}
            onClick={() => void startUpload()}
          >
            {busy ? "Uploading…" : "Upload"}
          </button>

          {error ? <div className="text-sm text-red-600">{error}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <StandaloneBrandedHeader kicker="Request upload" />
      {busy ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 py-10">
          <div className="w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-xl">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              Processing
            </div>
            <div className="mt-2 text-lg font-semibold text-[var(--fg)]">{statusLabel}</div>
            <div className="mt-2 text-sm text-[var(--muted)]">
              Please keep this tab open — closing or refreshing can interrupt the upload and processing.
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--primary-bg)]" />
            </div>
            <div className="sr-only" aria-live="polite">
              {statusLabel}
            </div>
          </div>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
          Request upload
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">
          {requestName || "Upload"}
        </div>
        {requestDescription ? (
          <div className="mt-2 text-sm text-[var(--muted)]">{requestDescription}</div>
        ) : null}

        {requireAuthToUpload ? (
          <>
            <AuthRequiredPanel />
            <AuthenticatedOnly>
              <UploadControls />
            </AuthenticatedOnly>
          </>
        ) : (
          <UploadControls />
        )}

        {savedPreview ? (
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {showSuccess ? "Upload successful" : "Your selected file (saved on this device)"}
                </div>
                {showSuccess ? (
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    The document was uploaded successfully and is now available to the requester.
                  </div>
                ) : null}
                <div className="mt-2 text-sm text-[var(--muted)]">
                  {savedPreview.fileName}
                  {savedPreview.contentType ? ` • ${savedPreview.contentType}` : ""}
                  {savedPreview.sizeBytes ? ` • ${formatBytes(savedPreview.sizeBytes)}` : ""}
                  {savedPreview.uploaded ? " • uploaded" : " • selected"}
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2">
                {showSuccess ? (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)]"
                    onClick={() => {
                      setDone(false);
                      setError(null);
                      setStatus({ step: "idle" });
                      fileInputRef.current?.click();
                    }}
                  >
                    Upload another
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)]"
                  onClick={() => {
                    safeClearLocalPreview(token);
                    setSavedPreview(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            {savedPreview.blobUrl || savedPreview.dataUrl ? (
              <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
                {/* Prefer blobUrl when present; fallback to small dataUrl selection preview. */}
                {(() => {
                  const src = savedPreview.blobUrl ?? savedPreview.dataUrl ?? "";
                  const ct = (savedPreview.contentType ?? "").toLowerCase();
                  if (ct.startsWith("image/")) {
                    // eslint-disable-next-line @next/next/no-img-element
                    return (
                      <img
                        src={src}
                        alt={`Preview of ${savedPreview.fileName}`}
                        className="max-h-[520px] w-full object-contain"
                      />
                    );
                  }
                  if (ct === "application/pdf") {
                    return (
                      <iframe
                        title={`Preview of ${savedPreview.fileName}`}
                        src={src}
                        className="h-[520px] w-full"
                      />
                    );
                  }
                  return null;
                })()}
              </div>
            ) : (
              <div className="mt-4 text-sm text-[var(--muted)]">
                Preview not available yet. The name/metadata is still saved locally.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}


