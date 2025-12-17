"use client";

import { upload } from "@vercel/blob/client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import LeftSidebar from "@/components/LeftSidebar";
import UploadButton from "@/components/UploadButton";
import UploadCompletionPanel from "@/components/UploadCompletionPanel";
import {
  BLOB_HANDLE_UPLOAD_URL,
  buildDocBlobPathname,
} from "@/lib/blob/clientUpload";
import { debugError, debugLog } from "@/lib/debug";
import { usePendingUpload } from "@/lib/pendingUpload";

type PreviewKind = "image" | "pdf" | null;

export default function Home() {
  const router = useRouter();
  const { pendingFile, setPendingFile, hasEnteredShell, setHasEnteredShell } =
    usePendingUpload();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<PreviewKind>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const shellOpen = useMemo(() => hasEnteredShell, [hasEnteredShell]);

  function resetForNewFile() {
    setIsFinishing(false);
    setFinishError(null);
    setSelectedFile(null);
    setFileName(null);
    setPreviewKind(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  function setFile(file: File) {
    // Only reset when we actually have a file selected.
    resetForNewFile();
    setSelectedFile(file);
    setFileName(file.name);
    setPreviewKind(file.type === "application/pdf" ? "pdf" : "image");
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  async function finishAndShare() {
    if (!selectedFile) return;
    if (selectedFile.type !== "application/pdf") return;
    if (isFinishing) return;

    setIsFinishing(true);
    setFinishError(null);
    try {
      debugLog(1, "[finishAndShare] start", {
        name: selectedFile.name,
        size: selectedFile.size,
      });

      // 1) Create doc + upload immediately
      const docRes = await fetch("/api/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: selectedFile.name }),
      });
      if (!docRes.ok) {
        const body = (await docRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to create doc");
      }
      const docJson = (await docRes.json()) as { doc: { id: string } };
      const docId = docJson.doc.id;

      const uploadRes = await fetch("/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docId,
          originalFileName: selectedFile.name,
          contentType: selectedFile.type,
          sizeBytes: selectedFile.size,
        }),
      });
      if (!uploadRes.ok) {
        const body = (await uploadRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to create upload");
      }
      const uploadJson = (await uploadRes.json()) as { upload: { id: string } };
      const uploadId = uploadJson.upload.id;

      // 2) Navigate immediately — do not block on upload completion
      debugLog(1, "[finishAndShare] route -> /doc/:id", { docId, uploadId });
      router.push(`/doc/${docId}`);

      // 3) Upload to Blob + trigger processing in background
      void (async () => {
        try {
          const pathname = buildDocBlobPathname({
            docId,
            uploadId,
            fileName: selectedFile.name,
          });

          debugLog(1, "[finishAndShare] blob upload starting", { pathname });
          const blob = await upload(pathname, selectedFile, {
            access: "public",
            handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
            contentType: selectedFile.type || undefined,
          });
          debugLog(1, "[finishAndShare] blob upload done", { url: blob.url });

          await fetch(`/api/uploads/${uploadId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "uploaded",
              blobUrl: blob.url,
              blobPathname: blob.pathname,
              metadata: { size: selectedFile.size },
            }),
          });

          debugLog(1, "[finishAndShare] trigger processing", { uploadId });
          await fetch(`/api/uploads/${uploadId}/process`, { method: "POST" });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Upload failed";
          debugError(1, "[finishAndShare] background failed", { message });
        }
      })();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to start share flow";
      setFinishError(message);
      debugError(1, "[finishAndShare] failed", { message });
    } finally {
      setIsFinishing(false);
    }
  }

  useEffect(() => {
    if (previewUrl) setHasEnteredShell(true);
  }, [previewUrl, setHasEnteredShell]);

  useEffect(() => {
    if (!pendingFile) return;
    setHasEnteredShell(true);
    setFile(pendingFile);
    setPendingFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!shellOpen) {
    return (
      <main className="grid min-h-screen place-items-center bg-white px-6 text-zinc-900">
        <div className="text-center">
          <div className="mx-auto flex items-center justify-center gap-3">
            <Image src="/icon.svg" alt="LinkDrop" width={28} height={28} priority />
            <h1 className="text-2xl font-semibold tracking-tight">LinkDrop</h1>
          </div>
          <p className="mt-2 text-sm font-medium text-zinc-600">Share docs. Smarter.</p>
          <div className="mt-6 flex justify-center">
            <UploadButton
              label="Select PDF"
              accept="pdf"
              onFileSelected={(file) => {
                setHasEnteredShell(true);
                setFile(file);
              }}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="flex h-[100svh] w-full bg-white text-zinc-900">
      <LeftSidebar onBeforeAddNewOpen={resetForNewFile} onAddNewFile={setFile} />

      <main className="min-w-0 flex-1">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-zinc-900">
                {fileName ?? "Preview"}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {previewUrl ? "Preview" : 'Drop a file anywhere or click “Add new”.'}
              </div>
              {finishError ? (
                <div className="mt-1 text-xs font-medium text-red-700">{finishError}</div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden bg-white">
            <div className="h-full px-6 py-6">
              <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[1.35fr_0.65fr]">
                <section className="relative min-h-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                  <div className="h-full w-full bg-zinc-50">
                    {previewUrl && previewKind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewUrl}
                        alt={fileName ?? "Uploaded image"}
                        className="h-full w-full object-contain"
                      />
                    ) : previewUrl && previewKind === "pdf" ? (
                      <iframe
                        title={fileName ? `Preview: ${fileName}` : "PDF preview"}
                        src={previewUrl}
                        className="block h-full w-full border-0"
                        allow="fullscreen"
                      />
                    ) : (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <div className="max-w-md">
                          <div className="text-base font-semibold">Add a PDF to preview</div>
                          <div className="mt-2 text-sm text-zinc-600">
                            Use “Add new” in the left sidebar, or drag & drop a file anywhere.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                <UploadCompletionPanel
                  hasPreview={!!previewUrl}
                  selectedFile={selectedFile}
                  isFinishing={isFinishing}
                  onFinishAndShare={finishAndShare}
                  onSelectFile={(file) => {
                    setHasEnteredShell(true);
                    setFile(file);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

