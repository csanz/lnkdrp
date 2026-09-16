/**
 * Plan CTA for the public pricing page (button + helper line).
 *
 * Signed out: Google sign-in, landing on the app. Signed in: reads the active workspace's billing
 * status and acts directly, so `/pricing` doubles as the plan page for existing users:
 * - Free card: "Current plan" when on Free, "Open app" when on Pro.
 * - Pro card: "Upgrade to Pro" starts Stripe Checkout; "Manage subscription" opens the billing portal.
 * Checkout needs a signed-in workspace, which is why signed-out users go through sign-in first.
 */
"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";
import { openBillingPortal, startCheckout } from "@/lib/billing/clientActions";
import { cn } from "@/lib/cn";
import Spinner from "@/components/ui/Spinner";

type Plan = "free" | "pro";

type Props = {
  /** Which card this CTA belongs to. */
  plan: Plan;
  /** `light` = solid black button for the white Pro card; `dark` = bordered button for dark cards. */
  variant?: "light" | "dark";
  /** Helper line shown under the button while signed out. */
  helper: string;
};

type BillingStatus = { plan: Plan; orgName: string | null };

const BASE =
  "inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-70";
const VARIANT = {
  light: "border border-black bg-black text-white shadow-sm hover:border-black/85 hover:bg-black/85",
  dark: "border border-white/15 bg-white/5 text-white hover:bg-white/10",
};
const HELPER = { light: "text-black/45", dark: "text-white/40" };

// One status fetch shared by both cards; the endpoint is also cached server-side.
let statusPromise: Promise<BillingStatus | null> | null = null;

/** Read the active workspace's plan once per page load; null when the request fails. */
function loadBillingStatus(): Promise<BillingStatus | null> {
  if (!statusPromise) {
    statusPromise = fetch("/api/billing/status")
      .then(async (res): Promise<BillingStatus | null> => {
        const json = (await res.json().catch(() => null)) as { plan?: string; org?: { name?: string | null } } | null;
        if (!res.ok || !json) return null;
        const plan: Plan = json.plan === "pro" ? "pro" : "free";
        return { plan, orgName: json.org?.name ?? null };
      })
      .catch(() => null);
  }
  return statusPromise;
}

/** Button + helper for a signed-out visitor: Google sign-in, then land in the app. */
function SignedOutCta({ plan, variant, helper }: Required<Props>) {
  const [busy, setBusy] = useState(false);
  const label = plan === "pro" ? "Upgrade to Pro" : "Get started";
  return (
    <>
      <button
        type="button"
        className={cn("relative", BASE, VARIANT[variant])}
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void signIn("google", { callbackUrl: plan === "pro" ? "/pricing" : "/" });
        }}
      >
        {/* Label kept in place under the spinner so the button never resizes; no provider named. */}
        <span className={busy ? "invisible" : ""}>{label}</span>
        {busy ? (
          <span className="absolute inset-0 grid place-items-center">
            <Spinner className="h-4 w-4" label="Signing in" />
          </span>
        ) : null}
      </button>
      <p className={cn("mt-3 min-h-[2.75rem] text-center text-[11px] leading-[1.4]", HELPER[variant])}>{helper}</p>
    </>
  );
}

/** Button + helper for a signed-in user, driven by the workspace's real billing status. */
function SignedInCta({ plan, variant }: Required<Props>) {
  const [status, setStatus] = useState<BillingStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadBillingStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = status?.plan ?? null;
  const where = status?.orgName ? `“${status.orgName}”` : "Your workspace";
  const helperText =
    status === undefined
      ? "Checking your plan…"
      : status === null
        ? "Couldn’t read your plan. Manage it from the dashboard."
        : `${where} is on the ${current === "pro" ? "Pro" : "Free"} plan.`;

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  };

  let control: ReactNode;
  if (plan === "free") {
    control =
      current === "pro" ? (
        <Link href="/" className={cn(BASE, VARIANT[variant])}>
          Open app
        </Link>
      ) : (
        <button type="button" className={cn(BASE, VARIANT[variant])} disabled>
          {current === "free" ? "Current plan" : "Get started"}
        </button>
      );
  } else if (current === "pro") {
    control = (
      <button
        type="button"
        className={cn(BASE, VARIANT[variant])}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void act(() => openBillingPortal())}
      >
        {busy ? "Opening…" : "Manage subscription"}
      </button>
    );
  } else {
    control = (
      <button
        type="button"
        className={cn(BASE, VARIANT[variant])}
        disabled={busy || status === undefined}
        aria-busy={busy}
        onClick={() =>
          void act(async () => {
            try {
              await startCheckout();
            } catch (e) {
              // Already subscribed (409): the portal is the right place.
              if (e instanceof Error && /already/i.test(e.message)) return openBillingPortal();
              throw e;
            }
          })
        }
      >
        {busy ? "Opening Stripe…" : "Upgrade to Pro"}
      </button>
    );
  }

  return (
    <>
      {control}
      <p className={cn("mt-3 min-h-[2.75rem] text-center text-[11px] leading-[1.4]", HELPER[variant])}>{error ?? helperText}</p>
    </>
  );
}

/** Session-aware branch; only mounted when auth is enabled (SessionProvider present). */
function SessionCta(props: Required<Props>) {
  const { status } = useSession();
  if (status === "authenticated") return <SignedInCta {...props} />;
  return <SignedOutCta {...props} />;
}

/**
 * Render the PricingCta UI (disabled when auth is off, e.g. local dev without Google).
 */
export default function PricingCta({ plan, variant = "dark", helper }: Props) {
  const authEnabled = useAuthEnabled();
  if (!authEnabled) {
    return (
      <>
        <button type="button" className={cn(BASE, VARIANT[variant])} disabled>
          {plan === "pro" ? "Upgrade to Pro" : "Get started"}
        </button>
        <p className={cn("mt-3 min-h-[2.75rem] text-center text-[11px] leading-[1.4]", HELPER[variant])}>{helper}</p>
      </>
    );
  }
  return <SessionCta plan={plan} variant={variant} helper={helper} />;
}
