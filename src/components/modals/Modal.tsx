"use client";

import { useEffect } from "react";

type Props = {
  open: boolean;
  children: React.ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  /**
   * Optional ref to the modal panel element.
   * Useful when parent components need click-outside logic.
   */
  panelRef?: React.Ref<HTMLDivElement>;
  /**
   * Optional additional classes for the modal panel (card).
   * Keep the backdrop consistent across the app.
   */
  panelClassName?: string;
  /**
   * Optional additional classes for the modal content container (the padded scroll area).
   * Useful to tweak spacing per-modal without changing global defaults.
   */
  contentClassName?: string;
};

export default function Modal({
  open,
  children,
  onClose,
  ariaLabel,
  panelRef,
  panelClassName,
  contentClassName,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <button
        type="button"
        className="absolute inset-0 bg-black/25 backdrop-blur-sm"
        aria-label="Close modal"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        className={[
          "absolute left-1/2 top-1/2 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
          "rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl ring-1 ring-black/5",
          panelClassName ?? "",
        ].join(" ")}
      >
        <div className="relative">
          <button
            type="button"
            className="absolute right-5 top-5 rounded-lg p-2 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
            aria-label="Close modal"
            onClick={onClose}
          >
            <XIcon />
          </button>

          <div
            className={[
              "max-h-[min(75vh,820px)] overflow-auto px-7 pb-7 pt-6",
              contentClassName ?? "",
            ].join(" ")}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function XIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
    </svg>
  );
}




