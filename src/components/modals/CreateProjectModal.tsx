"use client";

import Modal from "@/components/modals/Modal";
import PlanLimitNotice from "@/components/PlanLimitNotice";
import type { PlanLimitError } from "@/lib/client/planLimit";

/**
 * Create Project modal (used from the left sidebar).
 *
 * When the create call is refused with `402 plan_limit` (Free project cap), the caller passes the
 * parsed body as `limitError` and the modal shows an upgrade prompt instead of a plain error line.
 */
export default function CreateProjectModal({
  open,
  onClose,
  onCreate,
  busy,
  error,
  limitError = null,
  name,
  setName,
  description,
  setDescription,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: () => void;
  busy: boolean;
  error: string | null;
  /** Parsed `402 plan_limit` body from the last create attempt, if any. */
  limitError?: PlanLimitError | null;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      ariaLabel="New project"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-semibold text-[var(--fg)]">New project</div>
          {busy ? <div className="text-xs font-medium text-[var(--muted-2)]">Creating…</div> : null}
        </div>

        <div className="text-sm text-[var(--muted)]">
          Create a project to group docs. You can add docs to it later.
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="e.g. Fundraising"
            className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Description (optional)</div>
          <div className="mt-1 text-[11px] text-[var(--muted-2)]">
            Visible to recipients when you share this project link.
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            placeholder="What belongs here?"
            className="mt-2 min-h-[96px] w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>

        {limitError ? (
          <PlanLimitNotice error={limitError} secondaryLabel="Manage projects" secondaryHref="/search?scope=projects" />
        ) : error ? (
          <div className="text-sm font-medium text-red-700">{error}</div>
        ) : null}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
            disabled={busy}
            onClick={onCreate}
          >
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </Modal>
  );
}


