"use client";

import Modal from "@/components/modals/Modal";

/**
 * Removing someone from a workspace, with the consequences stated.
 *
 * It used to be `window.confirm("Remove this member from the workspace?")`, which names neither the
 * person nor what happens. Both matter here: the question is easy to answer wrongly when two
 * members share a display name, and the thing people actually hesitate over — "do their documents
 * leave with them?" — went unanswered. They do not, and saying so is what makes this a decision
 * rather than a gamble.
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

      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--fg)]">
        <div className="font-semibold">What happens</div>
        <ul className="mt-1 space-y-1 text-[var(--muted)]">
          <li>They lose access immediately — documents, projects, links and metrics in this workspace.</li>
          <li>
            <span className="text-[var(--fg)]">Nothing of theirs is deleted.</span> Documents they uploaded, the links
            they created and all analytics stay here, and those links keep working for recipients.
          </li>
          <li>Their own account and personal workspace are untouched.</li>
          <li>We email them that their access was removed, and the removal is recorded in this workspace&rsquo;s activity.</li>
          <li>You can invite them back later; an invite gives them the role you choose then.</li>
        </ul>
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
