"use client";

import UploadButton from "@/components/UploadButton";

type Props = {
  hasPreview: boolean;
  selectedFile: File | null;
  isFinishing: boolean;
  onFinishAndShare: () => void;
  onSelectFile: (file: File) => void;
};

/**
 * Phase 1 only (Upload flow, `/`).
 *
 * This component owns the Phase-1 “Finish and share” CTA language and must never
 * be used on `/doc/*`.
 */
export default function UploadCompletionPanel({
  hasPreview,
  selectedFile,
  isFinishing,
  onFinishAndShare,
  onSelectFile,
}: Props) {
  return (
    <aside className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted-2)]">
        {hasPreview ? "Review" : "Upload"}
      </div>
      <div className="mt-3">
        {hasPreview ? (
          <button
            id="finish-share"
            type="button"
            onClick={onFinishAndShare}
            disabled={!selectedFile || isFinishing}
            className="inline-flex w-full items-center justify-center rounded-lg bg-[var(--primary-bg)] px-5 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors transition-transform duration-150 hover:bg-[var(--primary-hover-bg)] active:scale-[0.98] disabled:opacity-50"
          >
            {isFinishing ? "Starting…" : "Finish and share"}
          </button>
        ) : (
          <UploadButton
            label="Browse files"
            accept="pdf"
            variant="cta"
            onFileSelected={onSelectFile}
            className="w-full justify-center"
          />
        )}
      </div>
      {hasPreview ? (
        <div className="mt-2 text-xs text-[var(--muted-2)]">Creates a private share link</div>
      ) : (
        <div className="mt-2 text-xs text-[var(--muted-2)]">Choose a PDF to preview before sharing.</div>
      )}
    </aside>
  );
}






