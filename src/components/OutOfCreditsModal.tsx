/**
 * Reusable "Out of credits" modal.
 *
 * Customer-facing: credits-first, no dollars, no vendor/model info. Copy is plan-aware: a Free
 * workspace has spent its one-time starter grant and is offered Pro (via the shared upgrade modal);
 * a Pro workspace has spent this cycle's credits and is sent to manage them.
 */
"use client";

import Modal from "@/components/modals/Modal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { CREDITS_COPY } from "@/lib/client/planLimit";
import type { OutOfCreditsReason } from "@/lib/client/outOfCredits";
import { usePlan } from "@/lib/client/usePlan";

export default function OutOfCreditsModal({
  open,
  onClose,
  onManageCredits,
  reason = "exhausted",
}: {
  open: boolean;
  onClose: () => void;
  onManageCredits: () => void;
  /** `daily_cap`: the Free daily brake, credits remain; `exhausted`: the balance is empty. */
  reason?: OutOfCreditsReason;
}) {
  const { plan } = usePlan();
  const { openUpgrade } = useUpgradeModal();
  // Unknown plan (snapshot not loaded yet) keeps the Pro copy, which never promises a grant.
  const isFree = plan?.plan === "free";

  const secondaryClass =
    "rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]";
  const primaryClass = "rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]";

  if (reason === "daily_cap") {
    return (
      <Modal open={open} onClose={onClose} ariaLabel="Daily credit cap reached">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Daily credit cap reached</div>
        <div className="mt-2 text-[13px] text-[var(--muted-2)]">
          Free workspaces can spend {CREDITS_COPY.freeDailyCap} credits a day. Your remaining credits are safe. Try again
          tomorrow, or upgrade to Pro, which has no daily cap.
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className={secondaryClass} onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className={primaryClass}
            onClick={() => {
              onClose();
              openUpgrade("credits");
            }}
          >
            Upgrade to Pro
          </button>
        </div>
      </Modal>
    );
  }

  if (isFree) {
    return (
      <Modal open={open} onClose={onClose} ariaLabel="Starter credits used">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">You’ve used your starter credits</div>
        <div className="mt-2 text-[13px] text-[var(--muted-2)]">
          Free workspaces start with {CREDITS_COPY.freeStarter} credits. Pro includes {CREDITS_COPY.proPerMonth} a month, and AI
          compare on every replacement.
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className={secondaryClass} onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className={primaryClass}
            onClick={() => {
              onClose();
              openUpgrade("credits");
            }}
          >
            Upgrade to Pro
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Out of credits">
      <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Out of credits</div>
      <div className="mt-2 text-[13px] text-[var(--muted-2)]">
        You’ve used all credits for this billing cycle. AI tools are currently unavailable.
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button type="button" className={secondaryClass} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={primaryClass} onClick={onManageCredits}>
          Manage credits
        </button>
      </div>
    </Modal>
  );
}
