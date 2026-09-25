/**
 * Subscription summary card for `/dashboard?tab=overview`.
 *
 * Shows current plan status and lets a signed-in user upgrade via Stripe Checkout (server-created session),
 * then manage billing via Stripe's customer portal. Plan details link out to `/pricing` so the comparison
 * has a single source of truth. The Free panel shows live usage meters from `GET /api/plan` (links,
 * projects, analytics window, members) and notes that AI summaries, version history and AI compare run on credits;
 * credits exist on both plans (Free starts with a one-time starter grant, then credit packs or Pro; Pro adds on-demand) and live
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
import { openBillingPortal, resumeSubscription, startCheckout as startCheckoutAction } from "@/lib/billing/clientActions";
import { CREDITS_COPY, FEATURE_CREDITS_ENABLED, FREE_PLAN_LIMITS_COPY, whatHappensAfterFreeCredits, PRO_SEATS_COPY } from "@/lib/client/planLimit";
import { usePlan } from "@/lib/client/usePlan";

type BillingStatusResponse = {
  plan?: string;
  /** `"month"` or `"year"` on Pro; the yearly plan prints its own price and has no on-demand. */
  interval?: "month" | "year" | null;
  stripeSubscriptionStatus?: string | null;
  stripeCurrentPeriodEnd?: string | null;
  stripeCancelAtPeriodEnd?: boolean;
  proPriceLabel?: string | null;
  proAnnualPriceLabel?: string | null;
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

/**
 * One plan panel. Module scope, not inside the card: declared inside render it was a new
 * component type every render, so React unmounted and remounted its subtree each time and the
 * spend-limit module in `rightSlot` lost whatever the person was typing (review M32).
 */
function PlanPanel({
  planLabel,
  price,
  subtitle,
  cta,
  rightSlot,
  banner,
}: {
  planLabel: string;
  price?: string;
  subtitle: React.ReactNode;
  cta: React.ReactNode;
  rightSlot?: React.ReactNode;
  /** Full-width notice above both columns (a cancelled plan), so it never shifts one column against the other. */
  banner?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5 sm:p-6">
      {banner ? <div className="mb-5">{banner}</div> : null}
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

export default function SubscriptionCard() {
  const router = useRouter();
  // Live limits/usage for the Free meters. Rows render (with empty bars) before the snapshot lands.
  const { plan: planSnapshot } = usePlan();
  const { openUpgrade } = useUpgradeModal();

  const [busy, setBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
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
  const annual = plan === "pro" && data?.interval === "year";
  const annualPriceLabel = typeof data?.proAnnualPriceLabel === "string" ? data.proAnnualPriceLabel.trim() : "";
  const monthlyPriceLabel = typeof data?.proPriceLabel === "string" ? data.proPriceLabel.trim() : "";
  // The price this workspace actually pays: the yearly label on the annual plan, else monthly.
  const proPriceLabel = annual ? annualPriceLabel || monthlyPriceLabel : monthlyPriceLabel;
  const annualOffered = plan === "free" && Boolean(annualPriceLabel);
  // Cancelled but still inside the paid period: Pro until the end date, then Free. Used to be a muted
  // "Cancels on <date>." inside the Pro card, which read as nothing having changed.
  const ending = plan === "pro" && Boolean(data?.stripeCancelAtPeriodEnd);
  const endDate = data?.stripeCurrentPeriodEnd ? formatShortDate(data.stripeCurrentPeriodEnd, { invalid: "empty" }) : "";
  const canManageBilling = planSnapshot?.role === "owner" || planSnapshot?.role === "admin";

  async function resumePro() {
    if (resumeBusy) return;
    setResumeBusy(true);
    setError(null);
    try {
      await resumeSubscription();
      const res = await fetch("/api/billing/status?fresh=1", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as BillingStatusResponse | null;
      if (res.ok && json) {
        setData(json);
        billingStatusCache = { data: json, at: Date.now() };
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resume the subscription");
    } finally {
      setResumeBusy(false);
    }
  }

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

  async function startCheckout(interval: "month" | "year" = "month") {
    if (upgradeBusy) return;
    setUpgradeBusy(true);
    setError(null);
    try {
      await startCheckoutAction({ interval });
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
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-card)] p-4 sm:p-6">
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
            planLabel={ending ? (endDate ? `Pro until ${endDate}` : "Pro, ending") : annual ? "Pro, yearly" : "Pro"}
            price={ending ? undefined : proPriceLabel || undefined}
            banner={
              ending ? (
                <div className="rounded-xl bg-[var(--plan-ending-bg)] px-4 py-3 text-[13px] leading-5 text-[var(--fg)]">
                  <span className="font-semibold text-[var(--plan-ending-fg)]">Pro is cancelled.</span> This workspace keeps Pro{" "}
                  {endDate ? `until ${endDate}` : "until the end of this billing period"}, then moves to Free. It won&apos;t renew.
                </div>
              ) : undefined
            }
            subtitle={
              <span>
                {ending ? "" : periodHint ? `${periodHint} ` : "Your subscription is active. "}Unlimited documents · Unlimited projects ·
                Deep analytics · Full history · {PRO_SEATS_COPY} teammates · unlimited free viewers.
              </span>
            }
            cta={
              <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
                {ending && canManageBilling ? (
                  <button
                    type="button"
                    className="w-full whitespace-normal rounded-lg bg-[var(--fg)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60 md:w-auto"
                    disabled={resumeBusy}
                    onClick={() => void resumePro()}
                  >
                    {resumeBusy ? "Resuming…" : "Resume Pro"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={
                    ending
                      ? "w-full whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60 md:w-auto"
                      : "w-full whitespace-normal rounded-lg bg-[var(--fg)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60 md:w-auto"
                  }
                  disabled={busy || manageBusy}
                  onClick={() => void openManageSubscription()}
                >
                  {manageBusy ? "Opening…" : "Manage subscription"}
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
                {annualOffered ? (
                  <button
                    type="button"
                    className="w-full whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60 md:w-auto"
                    disabled={busy || upgradeBusy}
                    onClick={() => void startCheckout("year")}
                    title={`${annualPriceLabel}, twelve months for the price of ten`}
                  >
                    Yearly, 2 months free
                  </button>
                ) : null}
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


