"use client";

import Modal from "@/components/modals/Modal";

/**
 * Render the ReviewPerspectiveModal UI.
 */
export default function ReviewPerspectiveModal({
  open,
  onClose,
  onSelectVentureCapitalist,
}: {
  open: boolean;
  onClose: () => void;
  onSelectVentureCapitalist: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Review perspective">
      <div className="text-base font-semibold text-[var(--fg)]">Review perspective</div>
      <div className="mt-1 text-sm text-[var(--muted)]">Choose the lens used to evaluate each submission.</div>

      <div className="mt-4 grid gap-2">
        <button
          type="button"
          className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-left hover:bg-[var(--panel-hover)]"
          onClick={onSelectVentureCapitalist}
        >
          <div className="text-sm font-semibold text-[var(--fg)]">Venture Capitalist</div>
          <div className="mt-1 text-sm text-[var(--muted)]">Pitch decks, updates, memos, board minutes.</div>
        </button>
        <button
          type="button"
          disabled
          className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-left opacity-60"
        >
          <div className="text-sm font-semibold text-[var(--fg)]">Coming soon</div>
          <div className="mt-1 text-sm text-[var(--muted)]">More perspectives will be available later.</div>
        </button>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)]"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}




