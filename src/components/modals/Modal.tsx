"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import IconButton from "@/components/ui/IconButton";

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
  /** Panel width in px (capped to the viewport); defaults to 520. Ignored when `panelClassName` sets a `w-` class. */
  width?: number;
};
/**
 * Render the Modal UI (uses effects).
 */


export default function Modal({
  open,
  children,
  onClose,
  ariaLabel,
  panelRef,
  panelClassName,
  contentClassName,
  width = 520,
}: Props) {
  useEffect(() => {
    if (!open) return;
/**
 * Handle key down events; uses onClose.
 */

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Mounted flag, so the portal only happens in the browser (there is no document on the server).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;

  // Through a portal to <body>, not in place: `position: fixed` is relative to the nearest ancestor
  // with a transform, filter or containment, and this modal is opened from rows deep inside
  // animated, clipped lists (the Activity feed's "What changed"). Rendered in place there, the
  // overlay covered the list instead of the viewport and the panel never appeared.
  return createPortal(
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
        aria-label="Close modal"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        className={[
          "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          "rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl ring-1 ring-[var(--border)]",
          panelClassName ?? "",
        ].join(" ")}
        // A width class in `panelClassName` (e.g. `w-[min(860px,…)]`) wins; the inline default would
        // otherwise override it and pin every such modal to 520px.
        style={/(^|\s)!?w-/.test(panelClassName ?? "") ? undefined : { width: `min(${width}px, calc(100vw - 32px))` }}
      >
        <div className="relative">
          <IconButton
            ariaLabel="Close modal"
            className="absolute right-4 top-4"
            onClick={onClose}
          >
            <XIcon />
          </IconButton>

          <div
            className={[
              "max-h-[min(85vh,820px)] overflow-auto px-7 pb-7 pt-6",
              contentClassName ?? "",
            ].join(" ")}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
/**
 * Render the XIcon UI.
 */


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




