"use client";

import Modal from "@/components/modals/Modal";

/**
 * Removing someone from a workspace.
 *
 * It used to be `window.confirm("Remove this member from the workspace?")`, which names neither the
 * person nor what happens. Both matter: the question is easy to answer wrongly when two members
 * share a display name, and the thing people hesitate over — "do their documents leave with them?"
 * — went unanswered.
 *
 * Two lines, not a briefing. The first version answered every question a reader might have in a
 * bulleted panel, which is more text than anyone reads in a confirmation and made a routine action
 * look grave. What stays is the person, and the one sentence that changes the decision.
 */
export default function RemoveMemberModal({
  open,
  busy,
  name,
  email,
  role,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  name: string | null;
  email: string | null;
  role: string | null;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const who = (name ?? "").trim() || (email ?? "").trim() || "this member";
  const address = (email ?? "").trim();
  const theirRole = (role ?? "").trim();

  return (
    <Modal
      open={open}
      ariaLabel="Remove member"
      onClose={() => {
        if (busy) return;
        onCancel();
      }}
      panelClassName="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-[var(--fg)]">Remove {who} from this workspace?</div>
      <div className="mt-2 text-sm text-[var(--muted)]">
        {address ? <span className="font-semibold text-[var(--fg)]">{address}</span> : null}
        {address && theirRole ? " · " : null}
        {theirRole ? <span>{theirRole}</span> : null}
      </div>

      <div className="mt-3 text-sm leading-6 text-[var(--muted)]">
        They lose access immediately. Nothing they uploaded is deleted and their links keep working. We&rsquo;ll
        email them, and you can invite them back any time.
      </div>

      {error ? <div className="mt-3 text-sm font-medium text-red-600">{error}</div> : null}

      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  );
}
