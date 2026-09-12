/**
 * UpgradeModal — the blocking Free → Pro prompt, opened through `useUpgradeModal()`.
 *
 * Built on the shared `Modal` so it matches the app: a "Pro" pill, the registry title and reason
 * (with "{used} of {max} used." and the grace hint appended when provided), three Pro benefits with
 * check icons, a price line, and two actions. The price comes from `GET /api/billing/status`
 * (`proPriceLabel`), fetched once per session and cached; when the request fails or the visitor is
 * not signed in, the line falls back to `PRO_PRICE_FALLBACK` and **Upgrade to Pro** links to
 * `/pricing`. Signed-in workspaces start Stripe Checkout directly (same call as the dashboard
 * Plan card). Pro workspaces never see it: the provider refuses to open, and this component closes
 * itself if the plan snapshot resolves to Pro.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import ProPill from "@/components/ProPill";
import { startCheckout } from "@/lib/billing/clientActions";
import { planLimitUsageSuffix } from "@/lib/client/planLimit";
import { PRO_PRICE_FALLBACK, UPSELL_COPY, type UpsellKey } from "@/lib/client/upsellCopy";
import { usePlan } from "@/lib/client/usePlan";

type Props = {
  open: boolean;
  upsellKey: UpsellKey;
  /** Current usage for counted limits; folded into the reason line when both are present. */
  used?: number;
  max?: number;
  /** Launch grace-period hint (see `planLimitGraceHint`). */
  graceHint?: string | null;
  onClose: () => void;
  /** False when auth is disabled for this deployment: skip the billing lookup, always link to `/pricing`. */
  checkoutEnabled?: boolean;
};

/** What the modal needs from `GET /api/billing/status`. */
type BillingEntry = { proPriceLabel: string | null; checkoutEligible: boolean };

// Fetched once per browser session: the price label does not change mid-session and the
// signed-in check is stable until a reload.
let billingEntryCache: BillingEntry | null = null;
let billingEntryInflight: Promise<BillingEntry> | null = null;

const NOT_ELIGIBLE: BillingEntry = { proPriceLabel: null, checkoutEligible: false };

/** Load (and cache) the Pro price label plus whether this visitor can start Checkout. */
async function loadBillingEntry(): Promise<BillingEntry> {
  if (billingEntryCache) return billingEntryCache;
  if (billingEntryInflight) return billingEntryInflight;
  billingEntryInflight = (async () => {
    try {
      const res = await fetch("/api/billing/status", { method: "GET" });
      if (res.status === 401) {
        billingEntryCache = NOT_ELIGIBLE;
        return NOT_ELIGIBLE;
      }
      if (!res.ok) return NOT_ELIGIBLE;
      const json = (await res.json().catch(() => null)) as { proPriceLabel?: unknown } | null;
      const label = typeof json?.proPriceLabel === "string" ? json.proPriceLabel.trim() : "";
      const entry: BillingEntry = { proPriceLabel: label || null, checkoutEligible: true };
      billingEntryCache = entry;
      return entry;
    } catch {
      return NOT_ELIGIBLE;
    } finally {
      billingEntryInflight = null;
    }
  })();
  return billingEntryInflight;
}

/** Render the upgrade modal for one upsell key. */
export default function UpgradeModal({
  open,
  upsellKey,
  used,
  max,
  graceHint,
  onClose,
  checkoutEnabled = false,
}: Props) {
  const copy = UPSELL_COPY[upsellKey];
  const { plan } = usePlan();
  const isPro = plan?.plan === "pro";
  const [billing, setBilling] = useState<BillingEntry | null>(() => billingEntryCache);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Never show the modal to a Pro workspace, even if a stale caller opened it.
  useEffect(() => {
    if (open && isPro) onClose();
  }, [open, isPro, onClose]);

  useEffect(() => {
    if (!open || !checkoutEnabled || billing) return;
    let cancelled = false;
    void loadBillingEntry().then((entry) => {
      if (!cancelled) setBilling(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [open, checkoutEnabled, billing]);

  const handleCheckout = useCallback(async () => {
    if (checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      await startCheckout();
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Failed to start checkout");
      setCheckoutBusy(false);
    }
  }, [checkoutBusy]);

  if (!open || isPro) return null;

  const usage = planLimitUsageSuffix({ used, max });
  const reason = [copy.reason, usage, graceHint ?? ""].filter(Boolean).join(" ");
  const price = billing?.proPriceLabel || PRO_PRICE_FALLBACK;
  const canCheckout = checkoutEnabled && Boolean(billing?.checkoutEligible);
  const primaryLabel = copy.primaryLabel ?? "Upgrade to Pro";
  const primaryClass =
    "inline-flex w-full items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-60 sm:w-auto";
  const secondaryClass =
    "inline-flex w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] sm:w-auto";

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={copy.title}
      panelClassName="motion-safe:animate-[lnkdrpUpgradeIn_180ms_ease-out]"
    >
      <div className="pr-8">
        <ProPill />
        <h2 className="mt-3 text-[17px] font-semibold leading-6 text-[var(--fg)]">{copy.title}</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted-2)]">{reason}</p>

        <ul className="mt-4 space-y-2.5">
          {copy.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2.5 text-[13px] leading-5 text-[var(--fg)]">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fg)]" aria-hidden="true" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[12px] leading-5 text-[var(--muted)]">Pro is {price} per workspace. Cancel anytime.</p>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={secondaryClass} onClick={onClose}>
            Not now
          </button>
          {canCheckout ? (
            <button type="button" className={primaryClass} disabled={checkoutBusy} onClick={() => void handleCheckout()}>
              {checkoutBusy ? "Opening…" : primaryLabel}
            </button>
          ) : (
            <Link href="/pricing" className={primaryClass} onClick={onClose}>
              {primaryLabel}
            </Link>
          )}
        </div>

        {checkoutError ? (
          <div role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-400">
            {checkoutError}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
