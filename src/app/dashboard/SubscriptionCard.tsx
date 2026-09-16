/**
 * Subscription summary card for `/dashboard?tab=overview`.
 *
 * Shows current plan status and lets a signed-in user upgrade via Stripe Checkout (server-created session),
 * then manage billing via Stripe's customer portal. Plan details link out to `/pricing` so the comparison
 * has a single source of truth. The Free panel shows live usage meters from `GET /api/plan` (links,
 * projects, analytics window, members) and notes that AI summaries, version history and AI compare run on credits;
 * credits exist on both plans (Free starts with a one-time starter grant, then credit packs or Pro) and live
 * in the Credits card on the Usage tab, so this card never reads the credits snapshot.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Alert from "@/components/ui/Alert";
import SpendLimitModule from "./SpendLimitModule";
import { formatShortDate } from "@/lib/format/date";
import PlanUsageMeter from "@/components/PlanUsageMeter";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { openBillingPortal, startCheckout as startCheckoutAction } from "@/lib/billing/clientActions";
import { CREDITS_COPY, FEATURE_CREDITS_ENABLED, FREE_PLAN_LIMITS_COPY, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import { usePlan } from "@/lib/client/usePlan";

type BillingStatusResponse = {
  plan?: string;
  stripeSubscriptionStatus?: string | null;
  stripeCurrentPeriodEnd?: string | null;
  stripeCancelAtPeriodEnd?: boolean;
  proPriceLabel?: string | null;
  error?: string;
};

// Small in-memory cache to avoid visible "loading" states on first render and
// when navigating between dashboard tabs (tab switches can unmount/remount cards).
const BILLING_STATUS_CACHE_TTL_MS = 30_000;
let billingStatusCache: { data: BillingStatusResponse; at: number } | null = null;

function normalizePlan(raw: string): "free" | "pro" {
  const v = raw.trim().toLowerCase();
  return v === "pro" ? "pro" : "free";
}

export default function SubscriptionCard() {
  const router = useRouter();
  // Live limits/usage for the Free meters. Rows render (with empty bars) before the snapshot lands.
  const { plan: planSnapshot } = usePlan();
  const { openUpgrade } = useUpgradeModal();

  const [busy, setBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BillingStatusResponse | null>(() => billingStatusCache?.data ?? null);

  useEffect(() => {
    let cancelled = false;
    const cachedAt = billingStatusCache?.at ?? 0;
    const cachedFresh = Boolean(billingStatusCache?.data) && Date.now() - cachedAt < BILLING_STATUS_CACHE_TTL_MS;
    // If we have a cached value, render immediately and refresh silently to avoid
    // visible flicker/loading states.
    setBusy(!cachedFresh);
    setError(null);
    void (async () => {
      try {
        // Fast-path: render the plan UI as soon as billing status returns.
        const billingRes = await fetch("/api/billing/status", { method: "GET" });
        const billingJson = (await billingRes.json().catch(() => null)) as BillingStatusResponse | null;
        if (!billingRes.ok) throw new Error((billingJson as any)?.error || `Request failed (${billingRes.status})`);
        if (!billingJson) throw new Error("Invalid response");
        if (!cancelled) setData(billingJson);
        billingStatusCache = { data: billingJson, at: Date.now() };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load subscription";
        // If we already have cached data rendered, keep it and avoid surfacing a transient error.
        if (!cancelled && !billingStatusCache?.data) setError(msg);
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
    return "Your current plan and its limits.";
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
    subtitle: React.ReactNode;
    cta: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5 sm:p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <div className="text-[18px] font-semibold tracking-tight text-[var(--fg)]">{planLabel}</div>
              {price ? <div className="text-[14px] font-semibold text-[var(--muted-2)]">{price}</div> : null}
            </div>
            <div className="mt-4 text-[12px] text-[var(--muted-2)]">{subtitle}</div>
            <div className="mt-5">{cta}</div>
          </div>
          {rightSlot ? <div className="w-full md:w-auto md:shrink-0">{rightSlot}</div> : null}
        </div>
      </div>
    );
  }

  /**
   * Free plan: live meters for the launch limits plus the Pro-only features, with `/pricing` as the
   * single source of truth. Values are `null` (dash + empty bar) until `usePlan` resolves so the
   * card keeps its height.
   */
  const freeSnapshot = planSnapshot?.plan === "free" ? planSnapshot : null;
  const freeAnalyticsDays = freeSnapshot?.limits.analyticsDays ?? FREE_PLAN_LIMITS_COPY.analyticsDays;
  const freeLimitsSubtitle = (
    <div>
      {/* Three meters on one row; analytics is a window, not a count, so it lives in the note below. */}
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        <PlanUsageMeter
          // "Docs", not "Links": this meter reads `usage.documents`, and the cap counts shared
          // documents — links are unlimited on every plan. The sidebar meter says the same.
          label="Docs"
          used={freeSnapshot ? freeSnapshot.usage.documents : null}
          max={freeSnapshot ? freeSnapshot.limits.documents : FREE_PLAN_LIMITS_COPY.documents}
          warn={Boolean(freeSnapshot?.atLimit.documents)}
        />
        <PlanUsageMeter
          label="Projects"
          used={freeSnapshot ? freeSnapshot.usage.projects : null}
          max={freeSnapshot ? freeSnapshot.limits.projects : FREE_PLAN_LIMITS_COPY.projects}
        />
        <PlanUsageMeter
          label="Members"
          used={freeSnapshot ? freeSnapshot.usage.members : null}
          max={freeSnapshot ? freeSnapshot.limits.collaborators + 1 : 1}
        />
      </div>
      <div className="mt-5 flex flex-col gap-2 border-t border-[var(--border)] pt-4 leading-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <span>
          Analytics cover the last {freeAnalyticsDays} days. AI summaries use credits: {CREDITS_COPY.freeStarter} to start,
          one time. Once they run out, {whatHappensAfterFreeCredits()}. Version history and AI compare run on credits too.
        </span>
        <button
          type="button"
          className="shrink-0 self-start font-semibold text-[var(--fg)] underline underline-offset-2 sm:self-auto"
          onClick={() => {
            // Lead with whichever cap is hit; otherwise the generic Pro pitch.
            if (freeSnapshot?.atLimit.documents) {
              openUpgrade("documents", {
                used: freeSnapshot.usage.documents,
                max: freeSnapshot.limits.documents ?? undefined,
              });
            } else if (freeSnapshot?.atLimit.projects) {
              openUpgrade("projects", { used: freeSnapshot.usage.projects, max: freeSnapshot.limits.projects ?? undefined });
            } else {
              openUpgrade("pro");
            }
          }}
        >
          See what&apos;s included
        </button>
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Plan</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">{topHint}</div>
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
            subtitle={
              <span>
                {periodHint ? periodHint : "Your subscription is active."} Unlimited documents · Unlimited projects · Deep
                analytics · full history · 1 collaborator included.
              </span>
            }
            cta={
              <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
                <button
                  type="button"
                  className="w-full whitespace-normal rounded-lg bg-[var(--fg)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60 md:w-auto"
                  disabled={busy || manageBusy}
                  onClick={() => void openManageSubscription()}
                >
                  {manageBusy ? "Opening…" : "Manage Subscription"}
                </button>
                <button
                  type="button"
                  className="w-full whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] md:w-auto"
                  onClick={() => router.push("/dashboard?tab=billing", { scroll: false })}
                >
                  Billing
                </button>
              </div>
            }
            rightSlot={FEATURE_CREDITS_ENABLED ? <SpendLimitModule className="md:w-[340px]" compact /> : undefined}
          />
        ) : (
          <PlanPanel
            planLabel="Free"
            subtitle={freeLimitsSubtitle}
            cta={
              <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
                <button
                  type="button"
                  className="w-full whitespace-normal rounded-lg bg-[var(--fg)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60 md:w-auto"
                  disabled={busy || upgradeBusy}
                  onClick={() => void startCheckout()}
                >
                  {upgradeBusy ? "Opening…" : "Upgrade to Pro"}
                </button>
                {FEATURE_CREDITS_ENABLED ? (
                  <Link
                    href="/credits"
                    className="w-full whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] md:w-auto"
                  >
                    Add more credits
                  </Link>
                ) : null}
                <Link
                  href="/pricing"
                  className="w-full whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] md:w-auto"
                >
                  View plan details
                </Link>
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

    </div>
  );
}


