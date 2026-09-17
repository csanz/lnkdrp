/**
 * The interactive part of `/billing/success`: waits for Stripe's webhook to confirm the upgrade,
 * then shows what the workspace now has and where to start.
 *
 * Access is never granted from the redirect. The page polls `/api/billing/status` until the webhook
 * has written the plan, so the "processing" state is real: Stripe has taken the payment, and Pro
 * turns on when its confirmation arrives, whether or not this page is still open.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { PAYG_DEFAULT_SPEND_LIMIT_CENTS } from "@/lib/billing/subscriptionState";
import { CREDITS_COPY } from "@/lib/client/planLimit";
import { formatUsdFromCents } from "@/lib/format/money";

type BillingStatus = {
  org?: { id: string; name: string | null; avatarUrl?: string | null };
  plan?: string;
  /** Free workspace whose pay-as-you-go subscription is billable; the plan stays "free". */
  payg?: boolean;
  stripeSubscriptionStatus?: string | null;
  stripeCurrentPeriodEnd?: string | null;
  stripeCancelAtPeriodEnd?: boolean;
  proPriceLabel?: string | null;
  error?: string;
};

type Phase = "processing" | "active" | "timeout" | "error";

type Props = {
  /** Accepted for debugging; never shown. */
  sessionId?: string;
  demo?: string;
  proCredits: number;
  proCollaborators: number;
};

/** How long to keep asking before showing "Stripe hasn't confirmed yet" (one request a second). */
const MAX_ATTEMPTS = 30;

function formatLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

const PRIMARY_BUTTON =
  "inline-flex items-center justify-center rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60";

export default function SuccessClient({ demo: demoRaw, proCredits, proCollaborators }: Props) {
  const demo = (demoRaw ?? "").trim().toLowerCase();
  const [phase, setPhase] = useState<Phase>("processing");
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Bumped by "Check again" to restart polling after a timeout or an error.
  const [run, setRun] = useState(0);
  // The balance after the upgrade, read once Pro is confirmed, so the page states what the workspace
  // actually has now rather than only what the plan promises.
  const [creditsNow, setCreditsNow] = useState<number | null>(null);

  useEffect(() => {
    // Demo mode previews every state without auth or Stripe; it never touches access control.
    // /billing/success?demo=auto | active | canceling | payg | timeout | error
    if (demo) {
      const inAMonth = new Date(Date.now() + 30 * 864e5).toISOString();
      const demoOrg = { id: "demo", name: "Personal" };
      const activeStatus: BillingStatus = { org: demoOrg, plan: "pro", stripeSubscriptionStatus: "active", stripeCurrentPeriodEnd: inAMonth };
      if (demo === "active") {
        setStatus(activeStatus);
        setPhase("active");
        return;
      }
      if (demo === "canceling") {
        setStatus({ ...activeStatus, stripeCancelAtPeriodEnd: true });
        setPhase("active");
        return;
      }
      if (demo === "payg") {
        setStatus({ org: demoOrg, plan: "free", payg: true });
        setPhase("active");
        return;
      }
      if (demo === "timeout") {
        setPhase("timeout");
        return;
      }
      if (demo === "error") {
        setMessage("The billing service did not answer.");
        setPhase("error");
        return;
      }
      setPhase("processing");
      const t = setTimeout(() => {
        setStatus(activeStatus);
        setPhase("active");
      }, 1800);
      return () => clearTimeout(t);
    }

    let cancelled = false;
    let attempts = 0;

    async function pollOnce(): Promise<boolean> {
      attempts += 1;
      try {
        const res = await fetch("/api/billing/status", { method: "GET", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as BillingStatus | null;
        if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
        const plan = typeof json?.plan === "string" ? json.plan.trim() : "free";
        // Pay-as-you-go checkout never makes the plan "pro"; its own flag is what confirms it.
        const done = plan === "pro" || json?.payg === true;
        if (!cancelled) {
          setStatus(json);
          if (done) setPhase("active");
        }
        return done;
      } catch (e) {
        if (!cancelled) {
          setMessage(e instanceof Error ? e.message : "The billing service did not answer.");
          setPhase("error");
        }
        return true;
      }
    }

    setPhase("processing");
    setMessage(null);
    const timer = setInterval(() => {
      void (async () => {
        const done = await pollOnce();
        if (done || attempts >= MAX_ATTEMPTS) {
          clearInterval(timer);
          if (!cancelled && !done) setPhase("timeout");
        }
      })();
    }, 1000);
    void pollOnce();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demo, run]);

  const workspaceName = status?.org?.name?.trim() || "Your workspace";
  const isPro = status?.plan === "pro";
  const paygActive = phase === "active" && !isPro && status?.payg === true;
  const proActive = phase === "active" && isPro;
  const periodEnd = formatLongDate(status?.stripeCurrentPeriodEnd);
  const canceling = Boolean(status?.stripeCancelAtPeriodEnd);

  // Pro checkout is only offered to workspaces that are not on Pro, so a confirmed Pro upgrade is
  // always a change from Free.
  useEffect(() => {
    if (!proActive) return;
    if (demo) {
      setCreditsNow(proCredits);
      return;
    }
    let cancelled = false;
    void fetch("/api/credits/snapshot?fast=1&bust=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { creditsRemaining?: unknown } | null) => {
        if (!cancelled && typeof j?.creditsRemaining === "number") setCreditsNow(j.creditsRemaining);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [proActive, demo, proCredits]);

  let headline: string;
  let lede: string;
  if (proActive) {
    headline = `Your workspace ${workspaceName} is now on Pro.`;
    lede = canceling
      ? `Heads up: this subscription is set to cancel. Pro stays on${periodEnd ? ` until ${periodEnd}` : " until the end of this billing period"}, then ${workspaceName} goes back to Free.`
      : `Your plan changed from Free to Pro. It applies to everyone in ${workspaceName}, and Stripe has emailed your receipt.`;
  } else if (paygActive) {
    headline = `Pay-as-you-go is on for ${workspaceName}.`;
    lede = `Your card is on file. Once your credits run out, AI features keep working at ${CREDITS_COPY.perCreditUsd} per credit, billed monthly for what you use, up to ${formatUsdFromCents(PAYG_DEFAULT_SPEND_LIMIT_CENTS)} a month. Change that limit any time in Limits.`;
  } else if (phase === "timeout") {
    headline = "Stripe hasn’t confirmed yet.";
    lede =
      "Your payment went through, but the confirmation that turns Pro on hasn’t reached us. It usually arrives within a minute, and Pro turns on by itself when it does, whether or not this page is open.";
  } else if (phase === "error") {
    headline = "We couldn’t check your plan.";
    lede = `${message ?? "The billing service did not answer."} Your payment is not affected. Check again, or open Billing to see the plan.`;
  } else {
    headline = "Confirming your upgrade.";
    lede =
      "Stripe has your payment. Pro turns on as soon as Stripe confirms it, usually within a few seconds. You can leave this page; it turns on either way.";
  }

  const initial = workspaceName.trim().charAt(0).toUpperCase() || "W";
  const done = proActive || paygActive;
  const problem = phase === "timeout" || phase === "error";

  // What changed, as a receipt: the facts someone checks right after paying.
  const rows: Array<{ label: string; value: ReactNode }> = proActive
    ? [
        {
          label: "Workspace",
          value: (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-md bg-black text-[11px] font-semibold text-white">
                {initial}
              </span>
              {workspaceName}
            </span>
          ),
        },
        {
          label: "Plan",
          value: (
            <span>
              <span className="text-black/45 line-through decoration-black/30">Free</span>
              <span className="mx-2 text-black/40" aria-hidden="true">
                →
              </span>
              <span className="font-semibold">Pro</span>
              {status?.proPriceLabel ? <span className="text-black/55"> · {status.proPriceLabel}</span> : null}
            </span>
          ),
        },
        {
          label: "AI credits",
          value: (
            <span>
              {creditsNow !== null ? `${creditsNow} available now` : `${proCredits} a month`}
              <span className="text-black/55"> · refills every month</span>
            </span>
          ),
        },
        { label: "Documents", value: "Unlimited, plus unlimited projects" },
        { label: "Analytics", value: "Who opened each link, time on every page" },
        {
          label: "Team",
          value: `${proCollaborators} ${proCollaborators === 1 ? "collaborator" : "collaborators"} included · agents never take a seat`,
        },
        {
          label: canceling ? "Pro ends" : "Renews",
          value: periodEnd ?? "At the end of each billing period",
        },
      ]
    : [];

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center text-center" aria-live="polite">
      <div
        aria-hidden="true"
        className={[
          "grid h-14 w-14 place-items-center rounded-full",
          done ? "bg-white text-black motion-safe:animate-[lnkdrpUpgradeIn_500ms_cubic-bezier(0.22,0.61,0.36,1)_both]" : "bg-white/10 text-white",
        ].join(" ")}
      >
        {done ? (
          <CheckIcon className="h-7 w-7" strokeWidth={2.25} />
        ) : problem ? (
          <ExclamationTriangleIcon className="h-6 w-6 text-white/80" />
        ) : (
          <Spinner className="h-6 w-6 text-white/70" label={null} />
        )}
      </div>

      {done ? (
        <p className="mt-6 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[13px] font-medium text-white/80">
          Payment confirmed · plan changed
        </p>
      ) : null}

      <h1 className="mt-5 font-serif text-balance text-4xl leading-[1.08] tracking-tight text-white sm:text-5xl">{headline}</h1>
      <p className="mt-4 max-w-lg text-balance text-base leading-7 text-white/65">{lede}</p>

      {rows.length ? (
        <dl className="mt-8 w-full overflow-hidden rounded-2xl bg-white text-left text-black shadow-[0_30px_80px_-30px_rgba(255,255,255,0.25)] motion-safe:animate-[lnkdrpUpgradeIn_500ms_cubic-bezier(0.22,0.61,0.36,1)_both]">
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={["flex flex-col gap-1 px-6 py-3.5 sm:flex-row sm:items-center sm:gap-6", i ? "border-t border-black/[0.07]" : ""].join(" ")}
            >
              <dt className="shrink-0 text-sm text-black/50 sm:w-28">{row.label}</dt>
              <dd className="min-w-0 text-[15px] leading-6 text-black/85">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {problem ? (
          <button type="button" onClick={() => setRun((r) => r + 1)} className={PRIMARY_BUTTON}>
            Check again
          </button>
        ) : (
          <Link href="/dashboard" className={PRIMARY_BUTTON}>
            Go to dashboard
          </Link>
        )}
        {problem ? (
          <Link href="/dashboard" className={SECONDARY_BUTTON}>
            Go to dashboard
          </Link>
        ) : null}
        <Link href="/dashboard?tab=billing" className={SECONDARY_BUTTON}>
          Manage billing
        </Link>
      </div>

      {proActive ? (
        <p className="mt-8 text-sm leading-6 text-white/50">
          Next:{" "}
          <Link href="/upload" className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white">
            share a document
          </Link>
          ,{" "}
          <Link href="/mcp" className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white">
            connect your agent
          </Link>
          , or{" "}
          <Link href="/dashboard?tab=teams" className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white">
            invite a collaborator
          </Link>
          .
        </p>
      ) : null}

      {demo ? (
        <p className="mt-8 text-[12px] text-white/40">
          Preview mode ({demo}). Nothing here checks Stripe or your account.
        </p>
      ) : null}
    </div>
  );
}
