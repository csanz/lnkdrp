/**
 * Subscription summary card for `/dashboard?tab=overview`.
 *
 * Shows current plan status and lets a signed-in user upgrade via Stripe Checkout (server-created session),
 * then manage billing via Stripe's customer portal.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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

function normalizePlan(raw: string): "free" | "pro" {
  const v = raw.trim().toLowerCase();
  return v === "pro" ? "pro" : "free";
}

export default function SubscriptionCard() {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
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

  const plan = normalizePlan(String(data?.plan ?? "free"));
  const status = (data?.stripeSubscriptionStatus ?? "").trim() || (plan === "pro" ? "active" : "free");
  const renewsOn = useMemo(() => {
    const end = data?.stripeCurrentPeriodEnd;
    if (!end || plan !== "pro") return "";
    const date = formatShortDate(end);
    return date ? `Renews on ${date}.` : "Renews at period end.";
  }, [data?.stripeCurrentPeriodEnd, plan]);

  const topHint = useMemo(() => {
    if (busy) return "Loading billing details…";
    if (error) return error;
    if (plan === "pro") return "Manage billing, invoices, and payment method.";
    return "Upgrade to unlock higher limits and advanced features.";
  }, [busy, error, plan]);

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

  function PlanCard({
    title,
    subtitle,
    current,
    cta,
    rightSlot,
  }: {
    title: string;
    subtitle: string;
    current?: boolean;
    cta: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) {
    return (
      <div className="rounded-2xl bg-[var(--panel-2)] p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[16px] font-semibold text-[var(--fg)]">{title}</div>
              {current ? (
                <span className="rounded-full bg-[var(--panel-hover)] px-2.5 py-1 text-[12px] font-semibold text-[var(--fg)]">
                  Current
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[12px] text-[var(--muted-2)]">{subtitle}</div>
            <div className="mt-4 flex flex-wrap items-center gap-2">{cta}</div>
          </div>
          {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-[var(--panel)] p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Subscription</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">{topHint}</div>
        </div>
        {plan === "pro" ? (
          <div className="text-[11px] font-semibold text-[var(--muted-2)]">Status: {status}</div>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3">
        <PlanCard
          title="Free"
          subtitle="A solid baseline for individual use."
          current={plan === "free"}
          cta={
            plan === "free" ? (
              <button
                type="button"
                className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                disabled={busy || upgradeBusy}
                onClick={() => void startCheckout()}
              >
                {upgradeBusy ? "Opening…" : "Upgrade"}
              </button>
            ) : (
              <div className="text-[12px] text-[var(--muted-2)]">Included with your account.</div>
            )
          }
        />

        <PlanCard
          title="Pro"
          subtitle={plan === "pro" ? (renewsOn ? renewsOn : "Your subscription is active.") : "Unlock higher limits and advanced features."}
          current={plan === "pro"}
          cta={
            plan === "pro" ? (
              <button
                type="button"
                className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                disabled={busy || manageBusy}
                onClick={() => void openManageSubscription()}
              >
                {manageBusy ? "Opening…" : "Manage Subscription"}
              </button>
            ) : (
              <div className="text-[12px] text-[var(--muted-2)]">Upgrade from Free to access Pro.</div>
            )
          }
          rightSlot={
            plan === "pro" ? (
              <div className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 md:w-[340px]">
                <div className="text-[12px] font-semibold text-[var(--fg)]">Usage this month</div>
                <div className="mt-1 text-[11px] text-[var(--muted-2)]">Coming soon.</div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]" aria-hidden="true">
                  <div className="h-2 w-1/2 rounded-full bg-[var(--muted-2)] opacity-60" />
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[12px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                    onClick={() => router.push("/dashboard?tab=usage", { scroll: false })}
                  >
                    View usage
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[12px] font-semibold text-[var(--muted-2)] opacity-60"
                    disabled
                    title="Not implemented yet"
                  >
                    Edit limit
                  </button>
                </div>
              </div>
            ) : null
          }
        />
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}


