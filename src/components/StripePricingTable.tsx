/**
 * Stripe Pricing Table embed component.
 *
 * Note on billing/access control:
 * - Stripe "pricing tables" are a hosted/Stripe-managed checkout surface.
 * - Our app's Pro access is **webhook-driven** and currently relies on Checkout metadata that includes `userId`.
 * - If you embed a pricing table for payments, those Checkout Sessions will NOT automatically include our `userId`,
 *   so the webhook will not be able to map the subscription back to a user (and Pro won't activate).
 *
 * Use this component for display/marketing, or extend the webhook mapping strategy before using it for upgrades.
 */
"use client";

import Script from "next/script";

export type StripePricingTableProps = {
  pricingTableId?: string;
  publishableKey?: string;
  className?: string;
};

export function StripePricingTable(props: StripePricingTableProps) {
  const pricingTableId = (props.pricingTableId ?? process.env.NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID ?? "").trim();
  const publishableKey = (props.publishableKey ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "").trim();

  if (!pricingTableId || !publishableKey) {
    return (
      <div className={props.className}>
        <div className="rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
          Stripe pricing table is not configured. Set{" "}
          <span className="font-mono">NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID</span> and{" "}
          <span className="font-mono">NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</span>.
        </div>
      </div>
    );
  }

  return (
    <div className={props.className}>
      <Script async src="https://js.stripe.com/v3/pricing-table.js" strategy="afterInteractive" />
      <stripe-pricing-table pricing-table-id={pricingTableId} publishable-key={publishableKey} />
    </div>
  );
}


