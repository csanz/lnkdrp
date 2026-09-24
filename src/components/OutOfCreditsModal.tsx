/**
 * Reusable "Out of credits" modal.
 *
 * Customer-facing: credits-first, no dollars beyond the pack price, no vendor/model info. Copy is
 * plan-aware and every variant routes to the door that actually works for that plan:
 * - Free (starter grant spent, or the daily cap): a credit pack first (`/credits`), Pro second.
 * - Yearly Pro: packs too. The yearly plan has no on-demand, so `/dashboard/limits` refuses it.
 * - Monthly Pro: manage on-demand credits at `/dashboard/limits`.
 *
 * The plan comes from `usePlan()` (`/api/plan`), which does not carry the billing interval, so a
 * Pro workspace reads `interval` from `GET /api/billing/status` when the modal opens. The read is
 * keyed to the workspace so a soft switch never shows the previous workspace's variant, and while
 * it is pending the monthly primary action is disabled: a fast click must not land on the on-demand
 * page that refuses yearly billing. A failed read keeps the monthly-Pro copy, which is what every
 * Pro workspace saw before yearly existed.
 */
"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/modals/Modal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { CREDITS_COPY } from "@/lib/client/planLimit";
import type { OutOfCreditsReason } from "@/lib/client/outOfCredits";
import { usePlan } from "@/lib/client/usePlan";
import { CREDIT_PACKS, formatPackPrice } from "@/lib/credits/packs";

/** Which Pro the workspace is on; `null` when the status read failed. */
type BillingInterval = "month" | "year" | null;

/** The interval read for one workspace. A different `orgId` means the read has not happened yet. */
type IntervalRead = { orgId: string; interval: BillingInterval };

// Last resolved read, kept across mounts so a reopen on the same workspace does not flash the
// monthly variant before the re-read lands.
let lastRead: IntervalRead | null = null;

/** The cheapest pack on sale: the modal's pack button is priced from it, never retyped. */
const CHEAPEST_PACK = CREDIT_PACKS.reduce((best, p) => (p.priceCents < best.priceCents ? p : best));
const BUY_PACK_LABEL = `Buy ${CHEAPEST_PACK.credits} credits for ${formatPackPrice(CHEAPEST_PACK.priceCents)}`;

/** Read the billing interval for a Pro workspace; `null` on any failure. */
async function loadInterval(): Promise<BillingInterval> {
  try {
    const res = await fetch("/api/billing/status", { method: "GET" });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { interval?: unknown } | null;
    return json?.interval === "year" ? "year" : json?.interval === "month" ? "month" : null;
  } catch {
    return null;
  }
}

/** Render the out-of-credits modal for the active workspace's plan and the given reason. */
export default function OutOfCreditsModal({
  open,
  onClose,
  onManageCredits,
  onBuyCredits,
  reason = "exhausted",
}: {
  open: boolean;
  onClose: () => void;
  /** Monthly Pro: go to on-demand settings. */
  onManageCredits: () => void;
  /** Free and yearly Pro: go to the credit packs. */
  onBuyCredits: () => void;
  /** `daily_cap`: the Free daily brake, credits remain; `exhausted`: the balance is empty. */
  reason?: OutOfCreditsReason;
}) {
  const { plan } = usePlan();
  const { openUpgrade } = useUpgradeModal();
  // Unknown plan (snapshot not loaded yet) keeps the Pro copy, which never promises a grant.
  const isFree = plan?.plan === "free";
  const isPro = plan?.plan === "pro";
  const orgId = plan?.orgId;
  const [read, setRead] = useState<IntervalRead | null>(() => lastRead);
  // A read from another workspace is as good as none: the soft switch keeps `plan.plan === "pro"`
  // while the interval may differ.
  const interval = read && read.orgId === orgId ? read.interval : undefined;
  const intervalPending = isPro && interval === undefined;

  // Only Pro needs the interval, and only while the modal is up: a Free workspace buys packs either
  // way. Re-read on each open so a switch to yearly mid-session is picked up.
  useEffect(() => {
    if (!open || !isPro || !orgId) return;
    let cancelled = false;
    void loadInterval().then((v) => {
      if (cancelled) return;
      lastRead = { orgId, interval: v };
      setRead(lastRead);
    });
    return () => {
      cancelled = true;
    };
  }, [open, isPro, orgId]);

  const secondaryClass =
    "rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]";
  const primaryClass = "rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]";
  const tertiaryClass =
    "rounded-md px-2 py-2 text-[13px] font-medium text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

  const upgrade = () => {
    onClose();
    openUpgrade("credits");
  };

  if (reason === "daily_cap") {
    return (
      <Modal open={open} onClose={onClose} ariaLabel="Daily credit cap reached">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Daily credit cap reached</div>
        <div className="mt-2 text-[13px] text-[var(--muted-2)]">
          Free workspaces can spend {CREDITS_COPY.freeDailyCap} credits a day. Your remaining credits are safe. Try again
          tomorrow, or buy a credit pack: a pack lifts the daily cap. Pro has no daily cap.
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={tertiaryClass} onClick={onClose}>
            Not now
          </button>
          <button type="button" className={secondaryClass} onClick={upgrade}>
            Upgrade to Pro
          </button>
          <button type="button" className={primaryClass} onClick={onBuyCredits}>
            {BUY_PACK_LABEL}
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
          Free workspaces start with {CREDITS_COPY.freeStarter} credits. Top up with a credit pack, or go Pro for{" "}
          {CREDITS_COPY.proPerMonth} credits a month and AI compare on every replacement.
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={tertiaryClass} onClick={onClose}>
            Not now
          </button>
          <button type="button" className={secondaryClass} onClick={upgrade}>
            Upgrade to Pro
          </button>
          <button type="button" className={primaryClass} onClick={onBuyCredits}>
            {BUY_PACK_LABEL}
          </button>
        </div>
      </Modal>
    );
  }

  if (isPro && interval === "year") {
    return (
      <Modal open={open} onClose={onClose} ariaLabel="Out of credits">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Out of credits</div>
        <div className="mt-2 text-[13px] text-[var(--muted-2)]">
          You’ve used all credits for this billing cycle. AI tools are currently unavailable. Yearly plans top up with a
          credit pack.
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className={secondaryClass} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryClass} onClick={onBuyCredits}>
            {BUY_PACK_LABEL}
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
        <button
          type="button"
          className={`${primaryClass} disabled:opacity-50`}
          onClick={onManageCredits}
          disabled={intervalPending}
        >
          Manage credits
        </button>
      </div>
    </Modal>
  );
}
