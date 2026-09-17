/**
 * Sheet — a dialog that slides in from the right (640px panel) on wide screens and fills the
 * screen below 640px. Portals to `document.body`, traps focus, locks body scroll and closes on
 * Escape. Stacked sheets close one at a time: only the top sheet reacts to Escape and Tab.
 */
"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  /** Id of the element that names the dialog (usually the title inside `header`). */
  labelledBy: string;
  /** Contents of the sticky 56px header bar. */
  header: React.ReactNode;
  children: React.ReactNode;
  /** Extra `data-*` attributes for the panel, which is also the sheet's scroll container. */
  dataAttributes?: Record<`data-${string}`, string>;
  /** Marks the panel busy while its content loads. */
  busy?: boolean;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open sheets, oldest first. Escape and Tab only act for the last entry.
const sheetStack: object[] = [];
let scrollLocks = 0;
let savedBodyOverflow = "";

function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = savedBodyOverflow;
  };
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

const noopSubscribe = () => () => {};

/** Right-hand sheet dialog (full screen under 640px) with focus trap, Escape and scroll lock. */
export default function Sheet({ open, onClose, labelledBy, header, children, dataAttributes, busy }: SheetProps) {
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !mounted) return;
    const token = {};
    sheetStack.push(token);
    const unlock = lockBodyScroll();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const first = focusableIn(panel)[0];
      (first ?? panel).focus({ preventScroll: true });
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== token) return;
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const i = sheetStack.lastIndexOf(token);
      if (i >= 0) sheetStack.splice(i, 1);
      unlock();
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[150]">
      <div
        className="absolute inset-0 hidden sm:block"
        style={{ backgroundColor: "rgba(0,0,0,0.2)" }}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy ? true : undefined}
        tabIndex={-1}
        className="absolute inset-0 overflow-y-auto overscroll-contain bg-[var(--panel)] text-[var(--fg)] shadow-2xl outline-none sm:left-auto sm:w-[640px] sm:border-l sm:border-[var(--border)]"
        {...dataAttributes}
      >
        <div className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 sm:px-5">
          {header}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
