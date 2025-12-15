"use client";

import { useEffect, useId, useRef, useState } from "react";

type Props = {
  label?: string;
};

function isAcceptedFile(file: File) {
  return file.type === "application/pdf" || file.type.startsWith("image/");
}

export default function UploadButton({ label = "Upload" }: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"image" | "pdf" | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  function setFile(file: File | null) {
    setFileName(file?.name ?? null);

    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPreviewKind(null);

    if (!file) return;
    if (!isAcceptedFile(file)) return;

    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    setPreviewKind(file.type === "application/pdf" ? "pdf" : "image");
  }

  useEffect(() => {
    // Enable drag & drop anywhere on the page (and prevent the browser from navigating to the dropped file).
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      // If the cursor leaves the window, dragend/leave often fires with no relatedTarget.
      if (!e.relatedTarget) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0] ?? null;
      if (file) setFile(file);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div className="mt-6 flex flex-col items-center gap-4">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="application/pdf,image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          setFile(file);
        }}
      />

      <button
        type="button"
        className="inline-flex items-center justify-center rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 focus-visible:ring-offset-2"
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>

      {previewUrl && previewKind === "image" ? (
        <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <img
            src={previewUrl}
            alt={fileName ?? "Uploaded image"}
            className="h-64 w-full object-contain"
          />
        </div>
      ) : null}

      {previewUrl && previewKind === "pdf" ? (
        <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <object
            data={previewUrl}
            type="application/pdf"
            className="h-72 w-full"
          >
            <div className="p-4 text-sm text-zinc-600">
              Preview not available. {fileName ?? "PDF selected."}
            </div>
          </object>
        </div>
      ) : null}

      {fileName ? <p className="text-sm text-zinc-600">{fileName}</p> : null}

      {isDragging ? (
        <div className="pointer-events-none fixed inset-4 z-50 rounded-2xl border border-zinc-300 bg-white/70 backdrop-blur-sm" />
      ) : null}
    </div>
  );
}


