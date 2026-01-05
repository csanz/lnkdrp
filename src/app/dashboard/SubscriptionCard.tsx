/**
 * Subscription summary card for `/dashboard?tab=overview`.
 *
 * Shows current plan status and lets a signed-in user upgrade via Stripe Checkout (server-created session),
 * then manage billing via Stripe's customer portal.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import SpendLimitModule from "./SpendLimitModule";
import { formatShortDate } from "@/lib/format/date";
import { openBillingPortal, startCheckout as startCheckoutAction } from "@/lib/billing/clientActions";

type BillingStatusResponse = {
  plan?: string;
  stripeSubscriptionStatus?: string | null;
  stripeCurrentPeriodEnd?: string | null;
  stripeCancelAtPeriodEnd?: boolean;
  proPriceLabel?: string | null;
  error?: string;
};

type CreditsSnapshotResponse = {
  ok: true;
  creditsRemaining: number;
  blocked?: boolean;
  error?: string;
};

function normalizePlan(raw: string): "free" | "pro" {
  const v = raw.trim().toLowerCase();
  return v === "pro" ? "pro" : "free";
}

export default function SubscriptionCard() {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BillingStatusResponse | null>(null);
  const [creditsBlocked, setCreditsBlocked] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    // Avoid rendering stale plan UI while we fetch the latest billing state.
    setData(null);
    setCreditsBlocked(null);
    void (async () => {
      try {
        const [billingRes, creditsRes] = await Promise.all([
          fetch("/api/billing/status", { method: "GET" }),
          fetch("/api/credits/snapshot", { method: "GET" }),
        ]);

        const billingJson = (await billingRes.json().catch(() => null)) as BillingStatusResponse | null;
        if (!billingRes.ok) throw new Error((billingJson as any)?.error || `Request failed (${billingRes.status})`);
        if (!billingJson) throw new Error("Invalid response");
        if (!cancelled) setData(billingJson);

        const creditsJson = (await creditsRes.json().catch(() => null)) as CreditsSnapshotResponse | null;
        if (creditsRes.ok && creditsJson && (creditsJson as any).ok === true) {
          if (!cancelled) setCreditsBlocked(Boolean((creditsJson as any).blocked));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load subscription";
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const planRaw = typeof data?.plan === "string" ? data.plan : "";
  const plan: "free" | "pro" | null = planRaw.trim() ? normalizePlan(planRaw) : null;
  const status = (data?.stripeSubscriptionStatus ?? "").trim() || (plan === "pro" ? "active" : "");
  const showStatusPill = plan === "pro" && status && status !== "active";
  const proPriceLabel = typeof data?.proPriceLabel === "string" ? data.proPriceLabel.trim() : "";
  const periodHint = useMemo(() => {
    const end = data?.stripeCurrentPeriodEnd;
    if (!end || plan !== "pro") return "";
    const cancels = Boolean(data?.stripeCancelAtPeriodEnd);
    const date = formatShortDate(end, { invalid: "empty" });
    if (cancels) return date ? `Cancels on ${date}.` : "Cancels at period end.";
    return date ? `Renews on ${date}.` : "Renews at period end.";
  }, [data?.stripeCurrentPeriodEnd, data?.stripeCancelAtPeriodEnd, plan]);

  const topHint = useMemo(() => {
    if (busy) return "Loading billing details…";
    if (error) return error;
    if (plan === "pro") return "Manage billing, invoices, and payment method.";
    return "Your current plan and credit status.";
  }, [busy, error, plan]);

  async function startCheckout() {
    if (upgradeBusy) return;
    setUpgradeBusy(true);
    setError(null);
    try {
      await startCheckoutAction();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout");
    } finally {
      setUpgradeBusy(false);
    }
  }

  async function openManageSubscription() {
    if (manageBusy) return;
    setManageBusy(true);
    setError(null);
    try {
      await openBillingPortal();
    } catch (e) {
      if (e instanceof Error && e.message === "Invalid portal URL") {
        setError("Invalid response");
      } else {
        setError(e instanceof Error ? e.message : "Failed to open billing portal");
      }
    } finally {
      setManageBusy(false);
    }
  }

  function PlanPanel({
    planLabel,
    price,
    subtitle,
    cta,
    rightSlot,
  }: {
    planLabel: string;
    price?: string;
    subtitle: string;
    cta: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) {
    return (
      <div className="rounded-2xl bg-[var(--panel-2)] p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[16px] font-semibold text-[var(--fg)]">{planLabel}</div>
              {price ? <div className="text-[14px] font-semibold text-[var(--muted-2)]">{price}</div> : null}
            </div>
            <div className="mt-1 text-[12px] text-[var(--muted-2)]">{subtitle}</div>
            <div className="mt-4 flex flex-wrap items-center gap-2">{cta}</div>
          </div>
          {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
        </div>
      </div>
    );
  }

  const outOfCredits = creditsBlocked === true;

  return (
    <div className="rounded-2xl bg-[var(--panel)] p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Plan</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            {topHint}{" "}
            <button
              type="button"
              className="font-semibold text-[var(--fg)] underline underline-offset-2"
              onClick={() => setDetailsOpen(true)}
            >
              See plan details
            </button>
          </div>
        </div>
        {showStatusPill ? <div className="text-[11px] font-semibold text-[var(--muted-2)]">Status: {status}</div> : null}
      </div>

      <div className="mt-5 grid gap-4">
        {plan === null ? (
          <div className="rounded-2xl bg-[var(--panel-2)] p-5">
            <div className="h-4 w-28 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
            <div className="mt-3 h-3 w-64 animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
            <div className="mt-6 flex items-center gap-2">
              <div className="h-9 w-32 animate-pulse rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
              <div className="h-9 w-20 animate-pulse rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
            </div>
          </div>
        ) : plan === "pro" ? (
          <PlanPanel
            planLabel="Pro"
            price={proPriceLabel || undefined}
            subtitle={periodHint ? periodHint : "Your subscription is active."}
            cta={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                  disabled={busy || manageBusy}
                  onClick={() => void openManageSubscription()}
                >
                  {manageBusy ? "Opening…" : "Manage Subscription"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                  onClick={() => router.push("/dashboard?tab=billing", { scroll: false })}
                >
                  Billing
                </button>
              </div>
            }
            rightSlot={<SpendLimitModule className="md:w-[340px]" compact />}
          />
        ) : (
          <PlanPanel
            planLabel="Free"
            subtitle={
              outOfCredits
                ? "AI tools are currently unavailable due to credit limits."
                : "Includes limited credits for this billing cycle."
            }
            cta={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                  disabled={busy || upgradeBusy}
                  onClick={() => void startCheckout()}
                >
                  {upgradeBusy ? "Opening…" : "Upgrade to Pro"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                  onClick={() => setDetailsOpen(true)}
                >
                  View plan details
                </button>
              </div>
            }
          />
        )}
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <Modal open={detailsOpen} onClose={() => setDetailsOpen(false)} ariaLabel="Plan details">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Plan details</div>
        <div className="mt-2 text-[13px] text-[var(--muted-2)]">
          You&apos;re currently on the{" "}
          <span className="font-semibold text-[var(--fg)]">{plan === "pro" ? "Pro" : plan === "free" ? "Free" : "…"}</span>{" "}
          plan.
        </div>

        <div className="mt-5 rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--fg)]">What&apos;s included</div>
          <ul className="mt-2 grid gap-1 text-[13px] leading-6 text-[var(--muted-2)]">
            <li>• Upload and organize PDFs in your workspace.</li>
            <li>• Share documents with optional password protection.</li>
            <li>• Access the Stripe billing portal for invoices and payment method (Pro only).</li>
            <li>• Usage limits and detailed usage reporting (coming soon).</li>
          </ul>
        </div>

        <div className="mt-4 rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--fg)]">Plan comparison</div>
          <div className="mt-2 grid gap-2 text-[13px] text-[var(--muted-2)] sm:grid-cols-2">
            <div className="rounded-lg bg-[var(--panel)] p-3">
              <div className="font-semibold text-[var(--fg)]">Free</div>
              <ul className="mt-1 grid gap-1">
                <li>• Limited credits per cycle.</li>
                <li>• Core doc upload + sharing.</li>
              </ul>
            </div>
            <div className="rounded-lg bg-[var(--panel)] p-3">
              <div className="font-semibold text-[var(--fg)]">Pro{proPriceLabel ? <span className="text-[var(--muted-2)]"> · {proPriceLabel}</span> : null}</div>
              <ul className="mt-1 grid gap-1">
                <li>• Higher limits + advanced features.</li>
                <li>• Billing portal access + on-demand controls.</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-xl bg-[var(--panel-hover)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)]"
            onClick={() => setDetailsOpen(false)}
          >
            Close
          </button>
          <button
            type="button"
            className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]"
            onClick={() => {
              setDetailsOpen(false);
              router.push("/dashboard?tab=billing", { scroll: false });
            }}
          >
            Billing
          </button>
        </div>
      </Modal>
    </div>
  );
}


