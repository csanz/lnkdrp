"use client";

import { useRouter } from "next/navigation";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import AgentHintNotice from "@/components/AgentHintNotice";
import Modal from "@/components/modals/Modal";
import PlanLimitNotice from "@/components/PlanLimitNotice";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { planLimitGraceHint, type PlanLimitError } from "@/lib/client/planLimit";
import { usePlan } from "@/lib/client/usePlan";

/**
 * Create Project modal (used from the left sidebar).
 *
 * When the create call is refused with `402 plan_limit` (Free project cap), the caller passes the
 * parsed body as `limitError` and the modal shows an inline upgrade note instead of a plain error
 * line. When the plan snapshot already says the Free workspace is at its project cap, the same
 * note is shown up front and the primary button is disabled, so the user never has to hit the 402.
 * The note's **Upgrade to Pro** closes this modal and opens the upgrade modal (no stacked dialogs).
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
  locked = false,
  setLocked,
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
  /** Create it as a private data room (docs/prds/lnkdrp-locked-projects.md). */
  locked?: boolean;
  /**
   * Omitted in a personal workspace, which hides the control entirely: a one-person workspace has
   * nobody to hide from, and a switch that does nothing is worse than no switch (decision 21).
   */
  setLocked?: (v: boolean) => void;
}) {
  const { plan } = usePlan();
  const { openUpgrade } = useUpgradeModal();
  const router = useRouter();
  const atProjectLimit = plan?.plan === "free" && plan.atLimit.projects;
  const showLimitNotice = Boolean(limitError) || atProjectLimit;

  /** Close this modal, then open the upgrade modal with the live project numbers. */
  function upgradeFromNotice() {
    onClose();
    openUpgrade("projects", {
      used: limitError?.used ?? plan?.usage.projects,
      max: limitError?.max ?? plan?.limits.projects ?? undefined,
      graceHint: planLimitGraceHint(limitError),
    });
  }

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

        {/* One notice at a time: at the cap, the plan limit is the thing that needs saying. */}
        {showLimitNotice ? null : <AgentHintNotice hintKey="create_project" />}

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

        {setLocked ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={locked}
                disabled={busy}
                onChange={(e) => setLocked(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--fg)]">
                  <LockClosedIcon className="h-3.5 w-3.5 text-[var(--muted-2)]" aria-hidden="true" />
                  Make it private
                </span>
                <span className="mt-0.5 block text-[12px] leading-5 text-[var(--muted-2)]">
                  Only the people you add will see this room. For everyone else in the workspace,
                  including owners, it does not appear at all. You can add people after you create it.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {showLimitNotice ? (
          <PlanLimitNotice
            error={limitError}
            limit="projects"
            secondaryLabel="Manage projects"
            // Close first: a link inside the modal would navigate underneath it and leave it open.
            onSecondary={() => {
              onClose();
              router.push("/search?scope=projects");
            }}
            onUpgrade={upgradeFromNotice}
          />
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
            disabled={busy || atProjectLimit}
            aria-disabled={busy || atProjectLimit}
            title={atProjectLimit ? "Project limit reached" : undefined}
            onClick={onCreate}
          >
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
