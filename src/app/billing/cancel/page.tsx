/**
 * Page for `/billing/cancel` — shown when a user cancels out of Stripe Checkout.
 */
import { StandaloneBrandedShell } from "@/components/StandaloneBrandedShell";

export default function BillingCancelPage() {
  return (
    <StandaloneBrandedShell kicker="Billing">
      <div className="rounded-2xl bg-[var(--panel)] p-8">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Checkout canceled</div>
        <div className="mt-2 text-[13px] leading-6 text-[var(--muted-2)]">
          No charges were made. You can try upgrading again anytime.
        </div>
        <div className="mt-6">
          <a className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]" href="/dashboard?tab=overview">
            Back to billing
          </a>
        </div>
      </div>
    </StandaloneBrandedShell>
  );
}


