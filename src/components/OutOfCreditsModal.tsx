/**
 * Reusable "Out of credits" modal.
 *
 * Customer-facing: credits-first, no dollars, no vendor/model info.
 */
"use client";

import Modal from "@/components/modals/Modal";

export default function OutOfCreditsModal({
  open,
  onClose,
  onManageCredits,
}: {
  open: boolean;
  onClose: () => void;
  onManageCredits: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Out of credits">
      <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Out of credits</div>
      <div className="mt-2 text-[13px] text-[var(--muted-2)]">
        You’ve used all credits for this billing cycle. AI tools are currently unavailable.
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]"
          onClick={onManageCredits}
        >
          Manage credits
        </button>
      </div>
    </Modal>
  );
}


