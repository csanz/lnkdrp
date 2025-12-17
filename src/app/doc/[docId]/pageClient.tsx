"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload as blobUpload } from "@vercel/blob/client";
import LeftSidebar from "@/components/LeftSidebar";
import UploadButton from "@/components/UploadButton";
import DocSharePanel from "@/components/DocSharePanel";
import {
  BLOB_HANDLE_UPLOAD_URL,
  buildDocBlobPathname,
} from "@/lib/blob/clientUpload";
import { usePendingUpload } from "@/lib/pendingUpload";

type DocStatus = "draft" | "preparing" | "ready" | "failed";
type UploadStatus =
  | "uploading"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed"
  | null;

type DocDTO = {
  id: string;
  shareId: string | null;
  title: string;
  status: DocStatus;
  currentUploadId: string | null;
  blobUrl: string | null;
  previewImageUrl: string | null;
  extractedText: string | null;
};

export default function DocPageClient({ initialDoc }: { initialDoc: DocDTO }) {
  const router = useRouter();
  const { setPendingFile } = usePendingUpload();
  const [doc, setDoc] = useState<DocDTO>(initialDoc);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [localPreviewUploadId, setLocalPreviewUploadId] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [preparingTick, setPreparingTick] = useState(0);
  const [hasHydratedFromServer, setHasHydratedFromServer] = useState(false);
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const hasAutoSelectedShareUrlRef = useRef(false);

  const preparingStartedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    // Reset preparing timer when we enter preparing.
    if (doc.status === "preparing" || doc.status === "draft") {
      preparingStartedAtRef.current = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.currentUploadId]);

  useEffect(() => {
    if (!(doc.status === "preparing" || doc.status === "draft")) return;
    const id = window.setInterval(() => setPreparingTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [doc.status]);

  useEffect(() => {
    // Once the new upload finishes and the server-side preview takes over, drop the local preview.
    if (!localPreviewUrl || !localPreviewUploadId) return;
    if (doc.status !== "ready") return;
    if (doc.currentUploadId !== localPreviewUploadId) return;
    setLocalPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setLocalPreviewUploadId(null);
  }, [doc.status, doc.currentUploadId, localPreviewUrl, localPreviewUploadId]);

  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch(`/api/docs/${doc.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { doc: DocDTO };
        if (cancelled) return;
        setDoc((prev) => ({ ...prev, ...data.doc }));
        setHasHydratedFromServer(true);
      } catch {
        // ignore
      }
    }

    void refresh();

    // Poll while:
    // - doc isn't ready yet, OR
    // - doc is ready but shareId hasn't arrived yet (we need it to form /share/:id).
    const shouldPoll = doc.status !== "ready" || !doc.shareId;
    if (!shouldPoll) return () => void 0;

    const id = window.setInterval(refresh, 900);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [doc.id, doc.status, doc.shareId]);

  const shareUrl = useMemo(() => {
    if (!doc.shareId) return "";
    const base =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    if (!base) return "";
    return new URL(`/share/${doc.shareId}`, base).toString();
  }, [doc.shareId]);

  useEffect(() => {
    // Auto-select the share URL once when the doc becomes ready.
    if (doc.status !== "ready") return;
    if (!shareUrl) return;
    if (hasAutoSelectedShareUrlRef.current) return;
    hasAutoSelectedShareUrlRef.current = true;
    shareInputRef.current?.focus();
    shareInputRef.current?.select();
  }, [doc.status, shareUrl]);

  useEffect(() => {
    // Defensive boundary enforcement: the doc page must never render Phase-1 CTAs.
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined") return;
    if (!window.location.pathname.startsWith("/doc/")) return;

    const offenders: string[] = [];
    if (document.getElementById("finish-share")) offenders.push("#finish-share");

    const interactive = Array.from(document.querySelectorAll("button, a"));
    const hasFinishText = interactive.some((el) =>
      /\bfinish\b/i.test((el.textContent ?? "").trim()),
    );
    const hasReadyToShareText = interactive.some((el) =>
      /ready to share/i.test((el.textContent ?? "").trim()),
    );
    if (hasFinishText) offenders.push("button/a text contains “Finish”");
    if (hasReadyToShareText) offenders.push("button/a text contains “Ready to share”");

    if (offenders.length) {
      // eslint-disable-next-line no-console
      console.error(
        "[DocPageClient] Phase-1 CTA leakage detected on /doc/* — this must never happen.",
        { offenders },
      );
    }
  }, []);

  const statusPill = useMemo(() => {
    if (!hasHydratedFromServer) {
      return { label: "Loading…", tone: "neutral" as const };
    }
    if (doc.status === "ready") return { label: "Ready", tone: "ok" as const };
    if (doc.status === "failed") return { label: "Upload failed", tone: "bad" as const };
    return { label: "Preparing…", tone: "neutral" as const };
  }, [doc.status, hasHydratedFromServer]);

  const displayDocName = useMemo(
    () => (doc.title || "Document").toString(),
    [doc.title],
  );

  const preparingMs = (() => {
    const _tick = preparingTick;
    void _tick;
    return Date.now() - preparingStartedAtRef.current;
  })();

  const overlayText = (() => {
    // forces re-render so the text can rotate by elapsed time
    const _tick = preparingTick;
    void _tick;
    if (!hasHydratedFromServer) return "Loading document…";
    const elapsed = Date.now() - preparingStartedAtRef.current;
    if (elapsed > 3000) return "Extracting text…";
    if (elapsed > 1500) return "Generating preview…";
    return "Preparing document…";
  })();

  async function copyLink() {
    if (!shareUrl) return;
    setIsCopying(true);
    setCopyDone(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyDone(true);
      window.setTimeout(() => setCopyDone(false), 1000);
    } catch {
      // ignore
    } finally {
      setIsCopying(false);
    }
  }

  async function replaceFile(file: File) {
    // Keep route stable; create a new upload record and rerun the pipeline.
    try {
      // Immediately clear the current view and show a local preview for the new file.
      setLocalPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });

      // Create a new upload record
      const upRes = await fetch("/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docId: doc.id,
          originalFileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        }),
      });
      if (!upRes.ok) {
        // Best effort: restore server-backed view.
        setLocalPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setLocalPreviewUploadId(null);
        router.refresh();
        return;
      }
      const upJson = (await upRes.json()) as { upload: { id: string } };
      const newUploadId = upJson.upload.id;
      setLocalPreviewUploadId(newUploadId);

      // Set local state to preparing immediately.
      setDoc((d) => ({
        ...d,
        status: "preparing",
        currentUploadId: newUploadId,
        previewImageUrl: null,
        extractedText: null,
      }));
      preparingStartedAtRef.current = Date.now();

      // Start direct-to-blob upload in the background (do not block UI).
      void (async () => {
        try {
          const pathname = buildDocBlobPathname({
            docId: doc.id,
            uploadId: newUploadId,
            fileName: file.name,
          });
          const blob = await blobUpload(pathname, file, {
            access: "public",
            handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
            contentType: file.type || undefined,
          });

          await fetch(`/api/uploads/${newUploadId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "uploaded",
              blobUrl: blob.url,
              blobPathname: blob.pathname,
              metadata: { size: file.size },
            }),
          });

          await fetch(`/api/uploads/${newUploadId}/process`, { method: "POST" });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Upload failed";
          try {
            await fetch(`/api/uploads/${newUploadId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "failed", error: { message } }),
            });
            await fetch(`/api/docs/${doc.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "failed" }),
            });
          } catch {
            // ignore
          }
        }
      })();
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex h-[100svh] w-full bg-white text-zinc-900">
      <LeftSidebar
        onAddNewFile={(file) => {
          setPendingFile(file);
          router.push("/");
        }}
      />

      {/* Center */}
      <main className="min-w-0 flex-1">
        <div className="flex h-full flex-col">
          {/* Top bar */}
          <div className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-zinc-900">
                {displayDocName}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <span
                  className={
                    statusPill.tone === "ok"
                      ? "rounded-full bg-emerald-50/70 px-3 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200/70"
                      : statusPill.tone === "bad"
                        ? "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-800 ring-1 ring-red-200"
                        : "rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 ring-1 ring-zinc-200"
                  }
                >
                  {statusPill.label}
                </span>
                {hasHydratedFromServer && doc.status === "ready" ? (
                  <div className="mt-1 text-[11px] font-medium text-zinc-500">
                    PDF processed
                  </div>
                ) : null}
              </div>

              <UploadButton
                label="Replace file"
                accept="pdf"
                variant="link"
                onFileSelected={replaceFile}
              />
            </div>
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-hidden bg-white">
            <div className="h-full px-6 py-6">
              <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[1.35fr_0.65fr]">
                <section className="relative min-h-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                  {/* progress bar (pinned top) */}
                  {(!hasHydratedFromServer ||
                    doc.status === "preparing" ||
                    doc.status === "draft") && (
                    <div className="absolute left-0 right-0 top-0 z-20 h-1 overflow-hidden bg-zinc-200">
                      <div className="h-full w-1/3 bg-zinc-900 animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                    </div>
                  )}

                  <div className="h-full w-full bg-zinc-50">
                    {localPreviewUrl ? (
                      <iframe
                        title="PDF preview"
                        src={localPreviewUrl}
                        className="block h-full w-full border-0"
                        allow="fullscreen"
                      />
                    ) : doc.previewImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={doc.previewImageUrl}
                        alt="Document preview"
                        className="h-full w-full object-contain"
                      />
                    ) : doc.blobUrl ? (
                      <iframe
                        title="PDF"
                        src={doc.blobUrl}
                        className="block h-full w-full border-0"
                        allow="fullscreen"
                      />
                    ) : (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <div className="text-sm font-medium text-zinc-600">
                          Preview will appear here.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* overlay */}
                  {(!hasHydratedFromServer ||
                    doc.status === "preparing" ||
                    doc.status === "draft") && (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-white/85">
                      <div className="rounded-2xl border border-zinc-200 bg-white/80 px-4 py-3 text-sm font-medium text-zinc-800 shadow-sm">
                        {overlayText}
                      </div>
                    </div>
                  )}
                </section>

                {doc.status === "ready" ? (
                  <DocSharePanel
                    shareUrl={shareUrl}
                    shareInputRef={shareInputRef}
                    isCopying={isCopying}
                    copyDone={copyDone}
                    onCopy={() => void copyLink()}
                  />
                ) : (
                  <aside className="min-h-0 overflow-auto rounded-2xl border border-zinc-200 bg-white p-5">
                    <div className="text-sm font-semibold">
                      {doc.status === "failed" ? "Upload failed" : "Preparing"}
                    </div>
                    <div className="mt-2 text-sm text-zinc-600">
                      {doc.status === "failed"
                        ? "Processing failed. Replace the file to try again."
                        : "We’re preparing your PDF. Nothing you need to do."}
                    </div>
                  </aside>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

    </div>
  );
}

