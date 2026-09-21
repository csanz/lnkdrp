"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isPdfFile, PDF_ONLY_MESSAGE } from "@/lib/client/docUploadPipeline";

type Props = {
  label?: string;
  onFileSelected?: (file: File) => void;
  /**
   * Called when the picked/dropped file is rejected (not a PDF). The button already shows the
   * message inline; use this to mirror it elsewhere (e.g. a page-level error slot).
   */
  onFileRejected?: (message: string) => void;
  /**
   * Called right before opening the OS file picker.
   * Return `false` to prevent the picker from opening (used for gating/upsell flows).
   */
  onBeforeOpen?: () => void | boolean;
  /**
   * Documents are PDF-only for now; `"pdfOrImage"` is kept for source compatibility but behaves
   * exactly like `"pdf"`.
   */
  accept?: "pdf" | "pdfOrImage";
  variant?: "pill" | "link" | "cta";
  className?: string;
  icon?: React.ReactNode;
  buttonId?: string;
  disabled?: boolean;
};

/** `accept` attribute for every document picker (MIME + extension for platforms that report neither well). */
const PDF_ACCEPT = "application/pdf,.pdf";
/** How long the inline "PDF only" hint stays visible. */
const REJECT_HINT_MS = 5_000;
/**
 * Render the UploadButton UI (uses effects).
 */


export default function UploadButton({
  label = "Upload",
  onFileSelected,
  onFileRejected,
  onBeforeOpen,
  accept = "pdf",
  variant = "pill",
  className,
  icon,
  buttonId,
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openedViaPointerDownRef = useRef(false);
  const [rejectMessage, setRejectMessage] = useState<string | null>(null);
  const rejectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rejectTimerRef.current) window.clearTimeout(rejectTimerRef.current);
    };
  }, []);

  /**
   * Validate a file and forward it to the consumer callback; non-PDFs show a short inline hint.
   */
  const handleFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (!isPdfFile(file)) {
        setRejectMessage(PDF_ONLY_MESSAGE);
        onFileRejected?.(PDF_ONLY_MESSAGE);
        if (rejectTimerRef.current) window.clearTimeout(rejectTimerRef.current);
        rejectTimerRef.current = window.setTimeout(() => setRejectMessage(null), REJECT_HINT_MS);
        return;
      }
      setRejectMessage(null);
      onFileSelected?.(file);
    },
    [onFileRejected, onFileSelected],
  );
/**
 * Open Picker (uses onBeforeOpen, click).
 */


  function openPicker() {
    if (disabled) return;
    const ok = onBeforeOpen?.();
    if (ok === false) return;
    // Allow picking the same file twice in a row.
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.click();
  }

  useEffect(() => {
/**
 * Handle drag over events; uses preventDefault.
 */

    // Enable drag & drop anywhere on the page (and prevent the browser from navigating to the dropped file).
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
/**
 * Handle drag enter events; uses preventDefault.
 */

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
    };
/**
 * Handle drag leave events; uses preventDefault.
 */

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
    };
/**
 * Handle drop events; uses preventDefault, handleFile.
 */

    const onDrop = (e: DragEvent) => {
      // `preventDefault` first and unconditionally: without it the browser navigates away to the
      // dropped file, which on a document page throws the reader out of the app entirely.
      e.preventDefault();
      // The same guard the click path has (`openPicker`). Dropping onto a button that is visibly
      // disabled — a document still preparing, say — used to start a replacement anyway, which then
      // failed server-side and looked like the page had simply blinked.
      if (disabled) return;
      const file = e.dataTransfer?.files?.[0] ?? null;
      if (file) handleFile(file);
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
  }, [handleFile, disabled]);

  // `accept` is intentionally unused beyond the prop type: documents are PDF-only.
  void accept;

  return (
    <div className="inline-flex flex-col items-center">
      <input
        ref={inputRef}
        type="file"
        accept={PDF_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          handleFile(file);
        }}
      />

      <button
        type="button"
        id={buttonId}
        disabled={disabled}
        aria-disabled={disabled}
        className={
          variant === "link"
            ? `inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${className ?? ""}`
            : variant === "cta"
              ? `inline-flex min-w-[132px] items-center justify-center rounded-lg bg-[var(--primary-bg)] px-5 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors transition-transform duration-150 hover:bg-[var(--primary-hover-bg)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--primary-bg)] disabled:active:scale-100 ${className ?? ""}`
              : `inline-flex items-center justify-center rounded-full bg-[var(--primary-bg)] px-4 py-2 text-[13px] font-medium text-[var(--primary-fg)] shadow-sm ring-1 ring-[var(--primary-border)] hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--primary-bg)] ${className ?? ""}`
        }
        onPointerDown={(e) => {
          if (disabled) return;
          // Open on pointer down so it feels instant (click fires on pointer up).
          // Guard so we don't open twice (pointerdown + click).
          if (e.pointerType === "mouse" || e.pointerType === "touch") {
            openedViaPointerDownRef.current = true;
            openPicker();
          }
        }}
        onClick={() => {
          if (disabled) return;
          // Keyboard activation (Enter/Space) won't trigger pointerdown.
          if (openedViaPointerDownRef.current) {
            openedViaPointerDownRef.current = false;
            return;
          }
          openPicker();
        }}
      >
        {icon ? icon : variant === "link" ? <AddNewIcon /> : null}
        {label}
      </button>
      {rejectMessage ? (
        <div role="alert" className="mt-2 text-xs font-medium text-red-600">
          {rejectMessage}
        </div>
      ) : null}
    </div>
  );
}
/**
 * Render the AddNewIcon UI.
 */


function AddNewIcon() {
  // Minimal “new” icon, similar vibe to ChatGPT's “New chat”
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="text-[var(--muted)]"
    >
      <path
        d="M12 7v10M7 12h10"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M7.5 3.75h9A3.75 3.75 0 0 1 20.25 7.5v9A3.75 3.75 0 0 1 16.5 20.25h-9A3.75 3.75 0 0 1 3.75 16.5v-9A3.75 3.75 0 0 1 7.5 3.75Z"
        stroke="currentColor"
        strokeWidth="1.8"
        opacity="0.55"
      />
    </svg>
  );
}
/**
 * Render the UploadIcon UI.
 */


export function UploadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


