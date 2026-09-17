/**
 * The interactive part of `/billing/success`: waits for Stripe's webhook to confirm the upgrade,
 * then shows what the workspace now has and where to start.
 *
 * Access is never granted from the redirect. The page polls `/api/billing/status` until the webhook
 * has written the plan, so the "processing" state is real: Stripe has taken the payment, and Pro
 * turns on when its confirmation arrives, whether or not this page is still open.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
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

  let headline: string;
  let lede: string;
  if (proActive) {
    headline = `${workspaceName} is on Pro.`;
    lede = canceling
      ? `Your subscription is set to cancel. Pro stays on${periodEnd ? ` until ${periodEnd}` : " until the end of this billing period"}, then this workspace goes back to Free.`
      : `${periodEnd ? `Your subscription renews on ${periodEnd}.` : "Your subscription is active."} You can cancel any time from Billing, and Pro stays on until the end of the period you paid for.`;
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

  return (
    <div>
      <div className="max-w-2xl" aria-live="polite">
        <h1 className="font-serif text-5xl leading-[1.04] tracking-tight text-white sm:text-6xl md:text-[56px]">{headline}</h1>
        <p className="mt-6 max-w-xl text-base leading-7 text-white/65">{lede}</p>
        {phase === "processing" ? (
          <div className="mt-6 flex items-center gap-3 text-sm text-white/55">
            <Spinner className="h-4 w-4 text-white/60" label={null} />
            Waiting for Stripe
          </div>
        ) : null}
      </div>

      {proActive ? (
        <>
          <div className="mt-12 grid overflow-hidden rounded-2xl bg-white text-black shadow-[0_30px_80px_-30px_rgba(255,255,255,0.25)] motion-safe:animate-[lnkdrpUpgradeIn_500ms_cubic-bezier(0.22,0.61,0.36,1)_both] md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <div className="p-7 sm:p-8">
              <p className="text-sm text-black/55">AI credits, every month</p>
              <p className="mt-2 font-serif text-6xl leading-none tracking-tight tabular-nums">{proCredits}</p>
              <p className="mt-4 max-w-xs text-sm leading-6 text-black/60">
                About 60 AI compares at standard quality. Unused credits don’t roll over to the next month.
              </p>
            </div>
            <div className="border-t border-black/10 p-7 sm:p-8 md:border-l md:border-t-0">
              <p className="text-sm text-black/55">What this workspace can do now</p>
              <ul className="mt-4 space-y-3 text-[15px] leading-6 text-black/85">
                <li>Unlimited documents and projects, with no cap on what you share</li>
                <li>See who opened each link and how long they spent on every page</li>
                <li>Recipients can browse every version and see what changed</li>
                <li>
                  {proCollaborators} {proCollaborators === 1 ? "collaborator" : "collaborators"} included, and agents never
                  take a seat
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-16">
            <h2 className="font-serif text-2xl tracking-tight text-white">Where to start</h2>
            <ul className="mt-5 divide-y divide-white/10 border-y border-white/10">
              {[
                { href: "/upload", title: "Share a document", body: "There is no document cap on Pro, so share the ones you were holding back." },
                { href: "/activity", title: "See who’s reading", body: "Every open is recorded, by name when the reader signs in." },
                { href: "/mcp", title: "Connect your agent", body: "Share and track documents from Claude Code, Cursor, or any MCP client." },
                { href: "/dashboard?tab=teams", title: "Invite a collaborator", body: "Work on this workspace’s documents together." },
              ].map((row) => (
                <li key={row.href}>
                  <Link
                    href={row.href}
                    className="group flex items-center gap-4 px-1 py-4 transition hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-white">{row.title}</span>
                      <span className="mt-0.5 block text-sm leading-6 text-white/55">{row.body}</span>
                    </span>
                    <ChevronRightIcon className="h-4 w-4 shrink-0 text-white/35 transition group-hover:text-white/70" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center gap-3">
        {phase === "timeout" || phase === "error" ? (
          <button type="button" onClick={() => setRun((r) => r + 1)} className={PRIMARY_BUTTON}>
            Check again
          </button>
        ) : (
          <Link href="/dashboard" className={PRIMARY_BUTTON}>
            Go to dashboard
          </Link>
        )}
        {phase === "timeout" || phase === "error" ? (
          <Link href="/dashboard" className={SECONDARY_BUTTON}>
            Go to dashboard
          </Link>
        ) : null}
        <Link href="/dashboard?tab=billing" className={SECONDARY_BUTTON}>
          Manage billing
        </Link>
      </div>

      {demo ? (
        <p className="mt-8 text-[12px] text-white/40">
          Preview mode ({demo}). Nothing here checks Stripe or your account.
        </p>
      ) : null}
    </div>
  );
}
