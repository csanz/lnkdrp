/**
 * UpgradeModal — the blocking Free → Pro prompt, opened through `useUpgradeModal()`.
 *
 * Built on the shared `Modal` as an upgrade sheet rather than a confirm dialog: a "Pro" pill, the
 * registry title and reason (with "{used} of {max} used." and the grace hint appended when
 * provided), three Pro benefits in an inset panel, a price block with the amount set large, a
 * full-width **Upgrade to Pro** action and a quiet **Not now** link. The price comes from
 * `GET /api/billing/status` (`proPriceLabel`), fetched once per session and cached; when the
 * request fails or the visitor is not signed in, it falls back to `PRO_PRICE_FALLBACK` and
 * **Upgrade to Pro** links to `/pricing`. Signed-in workspaces start Stripe Checkout directly (same
 * call as the dashboard Plan card). Pro workspaces never see it: the provider refuses to open, and
 * this component closes itself if the plan snapshot resolves to Pro.
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
type BillingEntry = {
  proPriceLabel: string | null;
  /** The yearly price ("$290/yr"); `null` when the deployment sells monthly only. */
  proAnnualPriceLabel: string | null;
  checkoutEligible: boolean;
};

// Fetched once per browser session: the price label does not change mid-session and the
// signed-in check is stable until a reload.
let billingEntryCache: BillingEntry | null = null;
let billingEntryInflight: Promise<BillingEntry> | null = null;

const NOT_ELIGIBLE: BillingEntry = { proPriceLabel: null, proAnnualPriceLabel: null, checkoutEligible: false };

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
      const json = (await res.json().catch(() => null)) as { proPriceLabel?: unknown; proAnnualPriceLabel?: unknown } | null;
      const label = typeof json?.proPriceLabel === "string" ? json.proPriceLabel.trim() : "";
      const annual = typeof json?.proAnnualPriceLabel === "string" ? json.proAnnualPriceLabel.trim() : "";
      const entry: BillingEntry = { proPriceLabel: label || null, proAnnualPriceLabel: annual || null, checkoutEligible: true };
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

/**
 * Split a price label such as "$29/mo" or "$29 / month" into the amount and its period so the
 * amount can be set large. Labels that do not start with an amount render whole.
 */
export function splitPriceLabel(label: string): { amount: string; period: string } {
  const m = /^(\p{Sc}?\s?\d[\d,]*(?:\.\d+)?)\s*(?:\/|per)?\s*(.*)$/u.exec(label.trim());
  if (!m) return { amount: label.trim(), period: "" };
  const raw = m[2].trim().toLowerCase();
  const period = raw === "" ? "" : raw === "mo" || raw === "month" || raw === "monthly" ? "per month" : raw === "yr" || raw === "year" || raw === "yearly" ? "per year" : `per ${raw}`;
  return { amount: m[1].replace(/\s+/g, ""), period };
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
  // Yearly is offered only when the deployment has a yearly price; otherwise monthly, as before.
  const [yearly, setYearly] = useState(false);
  const annualAvailable = Boolean(billing?.proAnnualPriceLabel);

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
      await startCheckout({ interval: yearly && annualAvailable ? "year" : "month" });
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Failed to start checkout");
      setCheckoutBusy(false);
    }
  }, [checkoutBusy, yearly, annualAvailable]);

  if (!open || isPro) return null;

  const usage = planLimitUsageSuffix({ used, max });
  const reason = [copy.reason, usage, graceHint ?? ""].filter(Boolean).join(" ");
  const showYearly = yearly && annualAvailable;
  const { amount, period } = splitPriceLabel(
    showYearly ? (billing?.proAnnualPriceLabel as string) : billing?.proPriceLabel || PRO_PRICE_FALLBACK,
  );
  const canCheckout = checkoutEnabled && Boolean(billing?.checkoutEligible);
  const primaryLabel = copy.primaryLabel ?? "Upgrade to Pro";
  const primaryClass =
    "inline-flex w-full items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-3 text-[15px] font-semibold text-[var(--primary-fg)] shadow-[0_1px_2px_var(--primary-shadow)] transition-colors hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] disabled:opacity-60";

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={copy.title}
      width={620}
      panelClassName="motion-safe:animate-[lnkdrpUpgradeIn_180ms_ease-out]"
      contentClassName="px-6 pb-6 pt-6 sm:px-10 sm:pb-9 sm:pt-9"
    >
      <div className="pr-6 sm:pr-8">
        <ProPill />
        <h2 className="mt-3.5 text-[22px] font-semibold leading-7 sm:mt-4 sm:text-[26px] sm:leading-8 tracking-[-0.015em] text-[var(--fg)] text-balance">{copy.title}</h2>
        <p className="mt-2 max-w-[46ch] text-[14px] leading-5 sm:mt-2.5 sm:text-[15px] sm:leading-6 text-[var(--muted-2)] text-pretty">{reason}</p>
      </div>

      <ul className="mt-5 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-4 sm:mt-7 sm:space-y-3.5 sm:px-5 sm:py-5">
        {copy.bullets.map((bullet, i) => (
          <li key={bullet} className="flex items-start gap-3.5 text-[15px] leading-6 text-[var(--fg)]">
            <span
              className={[
                "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                i === 0 ? "bg-[var(--primary-bg)] text-[var(--primary-fg)]" : "border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)]",
              ].join(" ")}
              aria-hidden="true"
            >
              <CheckIcon className="h-3 w-3" strokeWidth={3} />
            </span>
            <span className={i === 0 ? "font-medium" : ""}>{bullet}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-1.5 sm:mt-7 sm:gap-y-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[32px] font-semibold leading-none sm:text-[36px] tracking-[-0.02em] text-[var(--fg)] tabular-nums">{amount}</span>
            {period ? <span className="text-[14px] leading-5 text-[var(--muted-2)]">{period}</span> : null}
          </div>
          {annualAvailable ? (
            <div role="radiogroup" aria-label="Billing period" className="mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel-2)] p-0.5">
              {(
                [
                  ["month", "Monthly"],
                  ["year", "Yearly, 2 months free"],
                ] as const
              ).map(([value, label]) => {
                const active = showYearly ? value === "year" : value === "month";
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={[
                      "rounded-full px-2.5 py-1 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      active ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--muted-2)] hover:text-[var(--fg)]",
                    ].join(" ")}
                    onClick={() => setYearly(value === "year")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <p className="text-[13px] leading-5 text-[var(--muted)]">
          {showYearly ? "Per workspace, billed yearly. Cancel anytime." : "Per workspace. Cancel anytime."}
        </p>
      </div>

      <div className="mt-4 sm:mt-5">
        {canCheckout ? (
          <button type="button" className={primaryClass} disabled={checkoutBusy} onClick={() => void handleCheckout()}>
            {checkoutBusy ? "Opening checkout…" : primaryLabel}
          </button>
        ) : (
          <Link href="/pricing" className={primaryClass} onClick={onClose}>
            {primaryLabel}
          </Link>
        )}
        <div className="mt-3 flex items-center justify-between gap-4">
          <Link href="/pricing" className="text-[13px] font-medium text-[var(--muted-2)] underline-offset-4 hover:text-[var(--fg)] hover:underline" onClick={onClose}>
            Compare plans
          </Link>
          <button
            type="button"
            className="rounded-md px-1 text-[13px] font-medium text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={onClose}
          >
            Not now
          </button>
        </div>
      </div>

      {checkoutError ? (
        <div role="alert" className="mt-3 text-[13px] text-red-600 dark:text-red-400">
          {checkoutError}
        </div>
      ) : null}
    </Modal>
  );
}
