/**
 * Client component used by `/billing/success` to poll billing status.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";

type BillingStatus = {
  org?: { id: string; name: string | null; avatarUrl?: string | null };
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

export default function SuccessClient(props: { sessionId?: string; demo?: string }) {
  // `sessionId` is accepted for optional debugging, but we don't display it in the UI.
  const demo = (props.demo ?? "").trim();

  const [state, setState] = useState<{
    phase: "processing" | "active" | "timeout" | "error";
    status: BillingStatus | null;
    message?: string;
  }>({ phase: "processing", status: null });

  useEffect(() => {
    // Demo mode for UI preview without auth/Stripe. Does not affect real access control.
    // Try:
    // - /billing/success?demo=auto (processing → active)
    // - /billing/success?demo=active
    // - /billing/success?demo=timeout
    // - /billing/success?demo=error
    if (demo) {
      const d = demo.toLowerCase();
      if (d === "active") {
        setState({
          phase: "active",
          status: { plan: "pro", stripeSubscriptionStatus: "active", stripeCurrentPeriodEnd: new Date(Date.now() + 30 * 864e5).toISOString() },
        });
        return;
      }
      if (d === "timeout") {
        setState({ phase: "timeout", status: { plan: "free" } });
        return;
      }
      if (d === "error") {
        setState({ phase: "error", status: null, message: "Demo error: failed to confirm your subscription." });
        return;
      }
      // default: auto
      setState({ phase: "processing", status: { plan: "free" } });
      const t = setTimeout(() => {
        setState({
          phase: "active",
          status: { plan: "pro", stripeSubscriptionStatus: "active", stripeCurrentPeriodEnd: new Date(Date.now() + 30 * 864e5).toISOString() },
        });
      }, 1800);
      return () => clearTimeout(t);
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 30; // ~30s

    async function pollOnce() {
      attempts += 1;
      try {
        const res = await fetch("/api/billing/status", { method: "GET", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as BillingStatus | null;
        if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
        const plan = typeof json?.plan === "string" ? json.plan.trim() : "free";
        if (!cancelled) {
          setState({ phase: plan === "pro" ? "active" : "processing", status: json });
        }
        return plan === "pro";
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load billing status";
        if (!cancelled) setState({ phase: "error", status: null, message: msg });
        return true; // stop polling on error
      }
    }

    const timer = setInterval(() => {
      void (async () => {
        const done = await pollOnce();
        if (done || attempts >= maxAttempts) {
          clearInterval(timer);
          if (!cancelled && !done) setState((s) => ({ ...s, phase: "timeout" }));
        }
      })();
    }, 1000);

    // Kick off immediately (don’t wait 1s for first UI update).
    void pollOnce();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demo]);

  const headline = useMemo(() => {
    if (state.phase === "active") return "Pro active";
    if (state.phase === "timeout") return "Still processing…";
    if (state.phase === "error") return "Something went wrong";
    return "Processing payment…";
  }, [state.phase]);

  const detail = useMemo(() => {
    if (state.phase === "active") {
      const end = state.status?.stripeCurrentPeriodEnd;
      const status = (state.status?.stripeSubscriptionStatus ?? "").trim();
      const endText = end ? ` Renews on ${formatShortDate(end)}.` : "";
      // Avoid redundant copy: headline already communicates "Pro active".
      // Only mention the status if it's something other than "active" (e.g. trialing).
      const statusText = status && status.toLowerCase() !== "active" ? ` Status: ${status}.` : "";
      return `Pro is enabled for this workspace.${statusText}${endText}`;
    }
    if (state.phase === "timeout") {
      return "Stripe is still processing. This page will update automatically once the webhook updates your account.";
    }
    if (state.phase === "error") {
      return state.message || "Failed to confirm your subscription.";
    }
    return "Do not close this page — we’re waiting for Stripe to confirm your subscription.";
  }, [state.phase, state.status, state.message]);

  return (
    <div className="rounded-2xl bg-[var(--panel)] p-10">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">{headline}</div>
        {/* Extra breathing room around the workspace pill (not around the page header branding). */}
        <div className="mt-5 mb-5">
          <ActiveWorkspacePill maxWidthClassName="max-w-[360px]" textClassName="text-[12px]" />
        </div>
        <div className="text-[13px] leading-6 text-[var(--muted-2)]">{detail}</div>

        {demo ? (
          <div className="mt-4 rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
            Demo mode: <span className="font-mono">{demo}</span> (no polling, no auth required)
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Link className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]" href="/dashboard">
            Go to dashboard
          </Link>
          {state.phase !== "active" ? (
            <Link
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
              href="/dashboard?tab=overview"
            >
              Back to billing
            </Link>
          ) : null}
        </div>
    </div>
  );
}


