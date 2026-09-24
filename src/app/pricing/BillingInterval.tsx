/**
 * Monthly or yearly, chosen once on a Pro card and read by everything on it.
 *
 * The pricing page is a server component and the price block and the CTA are two different
 * corners of the same card, so the choice lives in a small client context that wraps the card:
 * `BillingIntervalToggle` draws the switch, `ProPriceBlock` the price for the chosen interval,
 * and `useBillingInterval` hands the interval to `PricingCta` when it starts Checkout. The
 * `/credits` page's Pro card uses the same provider and toggle. Without a yearly price on this
 * deployment the toggle is not drawn and everything reads as monthly, exactly as before.
 *
 * Yearly is twelve months for the price of ten. The per-month figure under the toggle comes from
 * the admin's price refresh (`/api/admin/billing/pro-price`), not from arithmetic here, so the page
 * never quotes a number Stripe will not charge.
 */
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export type BillingInterval = "month" | "year";

export type BillingStatusPlan = "free" | "pro";
export type BillingStatus = { plan: BillingStatusPlan; orgName: string | null };

// One status fetch shared by the toggle and both CTAs; the endpoint is also cached server-side.
let statusPromise: Promise<BillingStatus | null> | null = null;

/** Read the active workspace's plan once per page load; null when the request fails. */
export function loadBillingStatus(): Promise<BillingStatus | null> {
  if (!statusPromise) {
    statusPromise = fetch("/api/billing/status")
      .then(async (res): Promise<BillingStatus | null> => {
        const json = (await res.json().catch(() => null)) as { plan?: string; org?: { name?: string | null } } | null;
        if (!res.ok || !json) return null;
        const plan: BillingStatusPlan = json.plan === "pro" ? "pro" : "free";
        return { plan, orgName: json.org?.name ?? null };
      })
      .catch(() => null);
  }
  return statusPromise;
}

type Ctx = {
  interval: BillingInterval;
  setInterval: (next: BillingInterval) => void;
  /** Whether this deployment sells a yearly price at all. */
  annualAvailable: boolean;
};

const BillingIntervalContext = createContext<Ctx>({ interval: "month", setInterval: () => {}, annualAvailable: false });

/** Read the chosen interval; monthly outside a provider. */
export function useBillingInterval(): Ctx {
  return useContext(BillingIntervalContext);
}

/** Wrap a Pro card in this so its price, toggle and CTA agree. */
export function BillingIntervalProvider({ annualAvailable, children }: { annualAvailable: boolean; children: ReactNode }) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  return (
    <BillingIntervalContext.Provider value={{ interval: annualAvailable ? interval : "month", setInterval, annualAvailable }}>
      {children}
    </BillingIntervalContext.Provider>
  );
}

const TOGGLE_BTN = "rounded-full px-3 py-1 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40";

/**
 * The Monthly / Yearly switch. Renders nothing when the deployment has no yearly price, and
 * nothing for a workspace already on Pro: Checkout refuses a second subscription while one is
 * open (409), and the CTA beside it says "Manage subscription", so drawing the toggle for that
 * reader offered a choice that ended in an error. Interval changes for an existing subscription
 * are a portal or support action.
 */
export function BillingIntervalToggle({ className }: { className?: string }) {
  const { interval, setInterval, annualAvailable } = useBillingInterval();
  const [alreadyPro, setAlreadyPro] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadBillingStatus().then((s) => {
      if (!cancelled && s?.plan === "pro") setAlreadyPro(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!annualAvailable || alreadyPro) return null;
  const yearly = interval === "year";
  return (
    <div role="radiogroup" aria-label="Billing period" className={cn("inline-flex items-center gap-1 rounded-full bg-black/[0.06] p-1", className)}>
      <button
        type="button"
        role="radio"
        aria-checked={!yearly}
        className={cn(TOGGLE_BTN, !yearly ? "bg-black text-white shadow-sm" : "text-black/60 hover:text-black")}
        onClick={() => setInterval("month")}
      >
        Monthly
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={yearly}
        className={cn(TOGGLE_BTN, yearly ? "bg-black text-white shadow-sm" : "text-black/60 hover:text-black")}
        onClick={() => setInterval("year")}
      >
        Yearly <span className={cn("ml-1 font-normal", yearly ? "text-white/70" : "text-black/45")}>2 months free</span>
      </button>
    </div>
  );
}

/**
 * The pricing card's price: the toggle when a yearly price exists, then the amount for the chosen
 * interval and, on yearly, the per-month figure and what it saves.
 */
export function ProPriceBlock({
  monthlyLabel,
  annualLabel,
  annualPerMonthLabel,
}: {
  monthlyLabel: string | null;
  annualLabel: string | null;
  annualPerMonthLabel: string | null;
}) {
  const { interval, annualAvailable } = useBillingInterval();
  const yearly = annualAvailable && interval === "year";
  const label = yearly ? annualLabel : monthlyLabel;

  return (
    <div className="mt-4">
      <BillingIntervalToggle className="mb-3" />
      <div className="flex items-baseline gap-2">
        {label ? (
          <span className="font-serif text-5xl tracking-tight text-black">{label}</span>
        ) : (
          <>
            <span className="font-serif text-5xl tracking-tight text-black">{yearly ? "Yearly" : "Monthly"}</span>
            <span className="text-sm text-black/50">price shown at checkout</span>
          </>
        )}
      </div>
      <p className="mt-1 min-h-[20px] text-[13px] leading-5 text-black/55">
        {yearly
          ? `${annualPerMonthLabel ? `${annualPerMonthLabel}, ` : ""}billed yearly. Twelve months for the price of ten.`
          : annualAvailable
            ? "Billed monthly. Switch to yearly and pay for ten months, not twelve."
            : ""}
      </p>
    </div>
  );
}
