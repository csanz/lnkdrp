/**
 * Pre-upload preview + staging for creating a new doc.
 * Route: `/upload`
 */
"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UploadButton, { UploadIcon } from "@/components/UploadButton";
import { apiCreateDoc, apiCreateUpload, startBlobUploadAndProcess } from "@/lib/client/docUploadPipeline";
import { usePendingUpload } from "@/lib/pendingUpload";
import { fetchJson } from "@/lib/http/fetchJson";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";

const PdfJsViewer = dynamic(async () => (await import("@/components/PdfJsViewer")).PdfJsViewer, {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-[12px] text-[var(--muted)]" aria-live="polite">
      Loading preview…
    </div>
  ),
});

function titleFromFileName(name: string) {
  const base = (name ?? "").trim().replace(/\.[a-z0-9]+$/i, "");
  return base || "Untitled document";
}

function isPdfFile(file: File) {
  const name = (file.name ?? "").toLowerCase();
  return file.type === "application/pdf" || name.endsWith(".pdf");
}

export default function UploadPageClient() {
  const router = useRouter();
  const { pendingFile, setPendingFile } = usePendingUpload();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPendingRef = useRef<File | null>(null);

  useEffect(() => {
    if (!pendingFile) return;
    if (lastPendingRef.current === pendingFile) return;
    lastPendingRef.current = pendingFile;
    setPreviewLoading(true);
    setSelectedFile(pendingFile);
    setError(null);
    // Clear the cross-route buffer; keep the file in local state for this page.
    setPendingFile(null);
  }, [pendingFile, setPendingFile]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewLoading(false);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    // Immediately show a loading state while the browser sets up the preview URL.
    setPreviewLoading(true);
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    // Creating an object URL is typically fast; clear loading on next paint so the UI flips instantly.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => setPreviewLoading(false));
    } else {
      setPreviewLoading(false);
    }
    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };
  }, [selectedFile]);

  async function ensureOrgReadyForUpload() {
    try {
      const res = await fetchJson<{ claimed?: boolean; orgId?: string }>("/api/orgs/claim-join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const orgId = typeof res?.orgId === "string" ? res.orgId : "";
      if (res?.claimed && orgId && typeof window !== "undefined") {
        const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        try {
          await switchWorkspaceWithOverlay({ orgId, returnTo });
        } catch {
          window.location.assign(`/org/switch?orgId=${encodeURIComponent(orgId)}&returnTo=${encodeURIComponent(returnTo)}`);
        }
        throw new Error("Switching workspace…");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message === "Switching workspace…") throw e;
    }
  }

  const subtitle = useMemo(() => {
    if (!selectedFile) return "Choose a PDF to preview, then upload.";
    return "Review the PDF below. When you’re ready, click Upload.";
  }, [selectedFile]);

  async function handleUpload() {
    if (!selectedFile) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ensureOrgReadyForUpload();
      const docId = await apiCreateDoc({ title: titleFromFileName(selectedFile.name) });
      const upload = await apiCreateUpload({
        docId,
        originalFileName: selectedFile.name,
        contentType: selectedFile.type || "application/pdf",
        sizeBytes: selectedFile.size,
      });

      startBlobUploadAndProcess({
        docId,
        uploadId: upload.id,
        file: selectedFile,
        onFailure: async () => {
          // Best-effort; the doc page will surface status as it updates.
        },
      });

      router.push(`/doc/${encodeURIComponent(docId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]">
      {/* Top bar */}
      <div className="flex flex-col gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-3 md:flex-row md:items-center md:justify-between md:gap-4 md:px-6 md:py-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--fg)]">New document</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted)]">{subtitle}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={busy}
            onClick={() => router.push("/")}
          >
            Back
          </button>
          {selectedFile ? (
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-60"
              disabled={busy}
              onClick={() => void handleUpload()}
            >
              <UploadIcon />
              {busy ? "Uploading…" : "Upload"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div
          className={[
            "flex h-full min-h-0 flex-col md:flex-row",
            dragActive ? "ring-2 ring-[var(--ring)]" : "",
          ].join(" ")}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
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
            const file = e.dataTransfer?.files?.[0] ?? null;
            if (!file) return;
            if (!isPdfFile(file)) return;
            setPreviewLoading(true);
            setSelectedFile(file);
            setError(null);
          }}
        >
          {/* Viewer (left) */}
          <div className="min-h-0 flex-1 bg-black">
            {previewUrl ? (
              <PdfJsViewer url={previewUrl} initialPage={1} />
            ) : selectedFile || previewLoading ? (
              <div className="grid h-full min-h-0 place-items-center px-6 py-10">
                <div className="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-10 text-center">
                  <div className="text-lg font-semibold tracking-tight text-[var(--fg)]">Loading preview…</div>
                  <div className="mt-2 text-sm text-[var(--muted)]">
                    This can take a moment for larger PDFs.
                  </div>
                  <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                    <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 items-center justify-center px-6 py-10">
                <div className="w-full max-w-xl rounded-3xl border border-dashed border-[var(--border)] bg-[var(--panel)] p-10 text-center">
                  <div className="text-lg font-semibold tracking-tight text-[var(--fg)]">Choose a PDF</div>
                  <div className="mt-2 text-sm text-[var(--muted)]">
                    Select a document to preview it here before uploading.
                  </div>
                  <div className="mt-6 flex flex-col items-center gap-3">
                    <UploadButton
                      label="Choose a PDF"
                      accept="pdf"
                      variant="cta"
                      disabled={busy}
                      onFileSelected={(file) => {
                        if (!isPdfFile(file)) return;
                        setPreviewLoading(true);
                        setSelectedFile(file);
                        setError(null);
                      }}
                    />
                    <div className="text-xs text-[var(--muted)]">or drag & drop a PDF anywhere onto this page</div>
                  </div>
                  {error ? <div className="mt-4 text-sm font-medium text-red-600">{error}</div> : null}
                </div>
              </div>
            )}
          </div>

          {/* Side panel (right) */}
          <div className="w-full border-t border-[var(--border)] bg-[var(--panel)] p-4 md:w-[380px] md:border-l md:border-t-0">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">Selected file</div>
            {selectedFile ? (
              <div className="mt-2">
                <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{selectedFile.name}</div>
                <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                  {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                </div>
              </div>
            ) : (
              <div className="mt-2 text-[13px] text-[var(--muted)]">No file selected.</div>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={!selectedFile || busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)] disabled:opacity-60"
                onClick={() => void handleUpload()}
              >
                <UploadIcon />
                {busy ? "Uploading…" : "Upload"}
              </button>

              <div className="flex items-center justify-between gap-2">
                <UploadButton
                  label="Choose a different PDF"
                  accept="pdf"
                  variant="link"
                  disabled={busy}
                  onFileSelected={(file) => {
                    if (!isPdfFile(file)) return;
                    setPreviewLoading(true);
                    setSelectedFile(file);
                    setError(null);
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                  onClick={() => {
                    setSelectedFile(null);
                    setError(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            {error ? <div className="mt-4 text-sm font-medium text-red-600">{error}</div> : null}
            <div className="mt-4 text-[11px] leading-5 text-[var(--muted)]">
              Tip: drag & drop a PDF anywhere onto this page to replace the selection.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

