/**
 * Subscription summary card for `/dashboard?tab=overview`.
 *
 * Shows current plan status and lets a signed-in user upgrade via Stripe Checkout (server-created session),
 * then manage billing via Stripe's customer portal.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";

type BillingStatusResponse = {
  plan?: string;
  stripeSubscriptionStatus?: string | null;
  stripeCurrentPeriodEnd?: string | null;
  error?: string;
};

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function SubscriptionCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams?.get("tab") ?? "").trim();

  const [busy, setBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BillingStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/billing/status", { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingStatusResponse | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json) throw new Error("Invalid response");
        if (!cancelled) setData(json);
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

  const plan = (data?.plan ?? "free").trim() || "free";
  const status = (data?.stripeSubscriptionStatus ?? "").trim() || (plan === "pro" ? "active" : "free");
  const planName = plan === "pro" ? "Pro" : "Free";
  const canManage = plan === "pro";
  const isCurrentPlan = true;

  const secondary = useMemo(() => {
    if (busy) return "Loading billing details…";
    if (error) return error;

    const end = data?.stripeCurrentPeriodEnd;
    if (end && plan === "pro") {
      const date = formatShortDate(end);
      return date ? `Renews on ${date}.` : "Renews at period end.";
    }
    if (plan === "free") return "Upgrade to unlock higher limits and advanced features.";
    return "Manage billing, invoices, and payment method.";
  }, [busy, error, data, status, plan]);

  async function startCheckout() {
    if (upgradeBusy) return;
    setUpgradeBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST" });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      const url = typeof json?.url === "string" ? json.url : "";
      if (!url) throw new Error("Invalid response");
      // Redirect to Stripe Checkout.
      window.location.assign(url);
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
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      const url = typeof json?.url === "string" ? json.url : "";
      if (!url) throw new Error("Invalid response");
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open billing portal");
    } finally {
      setManageBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-[var(--panel)] p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--fg)]">Subscription</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            {secondary}{" "}
            <button
              type="button"
              className="font-semibold text-[var(--fg)] underline underline-offset-2"
              onClick={() => setDetailsOpen(true)}
            >
              See plan details
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="text-[16px] font-semibold text-[var(--fg)]">{planName}</div>
            {isCurrentPlan ? (
              <span className="rounded-full bg-[var(--panel-hover)] px-2.5 py-1 text-[12px] font-semibold text-[var(--fg)]">
                Current plan
              </span>
            ) : null}
            {plan !== "free" ? (
              <span className="rounded-full bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--muted-2)]">
                Status: {status}
              </span>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {plan === "free" ? (
              <button
                type="button"
                className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                disabled={busy || upgradeBusy}
                onClick={() => void startCheckout()}
              >
                {upgradeBusy ? "Opening…" : "Upgrade"}
              </button>
            ) : canManage ? (
              <button
                type="button"
                className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                disabled={busy || manageBusy}
                onClick={() => void openManageSubscription()}
              >
                {manageBusy ? "Opening…" : "Manage subscription"}
              </button>
            ) : (
              <button
                type="button"
                className="rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] opacity-60"
                disabled
                title="Not available"
              >
                Manage subscription
              </button>
            )}

            {tab !== "usage" ? (
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                onClick={() => router.push("/dashboard?tab=usage", { scroll: false })}
              >
                Usage
              </button>
            ) : null}
          </div>
          <div className="mt-2 text-right text-[11px] text-[var(--muted-2)]">
            {plan === "free" ? "Checkout opens in Stripe." : "Billing portal opens in Stripe."}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <Modal open={detailsOpen} onClose={() => setDetailsOpen(false)} ariaLabel="Plan details">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Plan details</div>
        <div className="mt-3 text-[13px] leading-6 text-[var(--muted-2)]">
          This modal is where we’ll describe what’s included in the <span className="font-semibold text-[var(--fg)]">{planName}</span>{" "}
          plan.
        </div>
        <div className="mt-5 rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
          Not finalized yet — tell me the exact inclusions/limits you want for Free vs paid, and I’ll populate this list.
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]"
            onClick={() => setDetailsOpen(false)}
          >
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}


