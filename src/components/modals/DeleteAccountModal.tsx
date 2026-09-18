"use client";

/**
 * Asking to delete an account: what happens, why they are leaving, and a typed confirmation.
 *
 * Deletion is immediate and reversible for 30 days, so the modal says both halves plainly — what
 * stops working now, and what is destroyed later. The reason is optional; it is asked here rather
 * than in a follow-up email because this is the only moment the person is still present.
 */
import { useState } from "react";
import { signOut } from "next-auth/react";

import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import { DELETION_CONFIRM_PHRASE, DELETION_GRACE_DAYS, DELETION_REASONS, confirmPhraseMatches } from "@/lib/accounts/deletion";

export default function DeleteAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmPhraseMatches(confirm) && !busy;

  async function submit() {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reasonCode: reasonCode || undefined, reasonText: reasonText || undefined, confirm }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      // The account is already disabled server-side; end the session so the app does not sit on a
      // token that every request now refuses.
      await signOut({ callbackUrl: "/?deleted=1" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the account");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      ariaLabel="Delete account"
      panelClassName="w-[min(560px,calc(100vw-32px))]"
      contentClassName="px-6 pb-6 pt-5"
    >
      <div className="pr-10">
        <div className="text-base font-semibold text-[var(--fg)]">Delete account</div>
        <p className="mt-2 text-[13px] leading-5 text-[var(--muted)]">
          Your account stops working straight away: you are signed out, your agent keys stop, and every share link in a
          workspace only you belong to stops opening for its recipients.
        </p>
        <p className="mt-2 text-[13px] leading-5 text-[var(--muted)]">
          Your documents and data are kept for {DELETION_GRACE_DAYS} days in case this was a mistake, then deleted for good,
          files included. Workspaces you share with other people carry on without you.
        </p>
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <div className="mt-5 grid gap-4">
        <div>
          <label className="text-[12px] font-semibold text-[var(--muted-2)]" htmlFor="delete-reason">
            Why are you leaving? (optional)
          </label>
          <select
            id="delete-reason"
            className="mt-2 h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-[var(--fg)]"
            value={reasonCode}
            disabled={busy}
            onChange={(e) => setReasonCode(e.target.value)}
          >
            <option value="">Rather not say</option>
            {DELETION_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[12px] font-semibold text-[var(--muted-2)]" htmlFor="delete-reason-text">
            Anything else? (optional)
          </label>
          <textarea
            id="delete-reason-text"
            rows={3}
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)]"
            placeholder="What would have kept you here?"
            value={reasonText}
            disabled={busy}
            onChange={(e) => setReasonText(e.target.value)}
          />
        </div>

        <div>
          <label className="text-[12px] font-semibold text-[var(--muted-2)]" htmlFor="delete-confirm">
            Type <span className="font-mono text-[var(--fg)]">{DELETION_CONFIRM_PHRASE}</span> to confirm
          </label>
          <input
            id="delete-confirm"
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)]"
            value={confirm}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
          disabled={busy}
          onClick={onClose}
        >
          Keep my account
        </button>
        <button
          type="button"
          className="rounded-lg bg-red-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          disabled={!canDelete}
          onClick={() => void submit()}
        >
          {busy ? "Deleting…" : "Delete my account"}
        </button>
      </div>
    </Modal>
  );
}
