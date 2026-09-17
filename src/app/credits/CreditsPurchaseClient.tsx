/**
 * The interactive part of `/credits`: the workspace's balance, one card per pack, the Pro card, and
 * the confirmation shown when Stripe sends the buyer back.
 *
 * Signed out, a pack button signs in first and returns here. Signed in, it starts a one-time
 * Checkout (`POST /api/credits/purchase`). On return (`?purchase=success&session_id=…`) it polls
 * `GET /api/credits/purchase` until the webhook has granted the credits, since the redirect alone
 * proves nothing. The Pro card is hidden for workspaces already on Pro.
 */
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";
import Spinner from "@/components/ui/Spinner";
import PricingCta from "@/app/pricing/PricingCta";
import { type CreditPack, formatPackPrice, formatPerCredit } from "@/lib/credits/packs";
import { formatShortDate } from "@/lib/format/date";
import { cn } from "@/lib/cn";

type Props = { packs: CreditPack[]; proPriceLabel: string | null; proCredits: number };

const BUTTON =
  "relative inline-flex w-full items-center justify-center rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-70";

export default function CreditsPurchaseClient(props: Props) {
  const authEnabled = useAuthEnabled();
  // `useSession` needs the SessionProvider, which is only mounted when auth is enabled.
  return (
    <Suspense>
      {authEnabled ? <WithSession {...props} /> : <Body {...props} signedIn={false} authEnabled={false} />}
    </Suspense>
  );
}

function WithSession(props: Props) {
  const { data, status } = useSession();
  return (
    <Body
      {...props}
      signedIn={status === "authenticated"}
      accountEmail={data?.user?.email ?? null}
      authEnabled
      sessionLoading={status === "loading"}
    />
  );
}

type Workspace = { name: string | null; plan: "free" | "pro"; credits: number | null };

function Body({
  packs,
  proPriceLabel,
  proCredits,
  signedIn,
  accountEmail = null,
  authEnabled,
  sessionLoading = false,
}: Props & { signedIn: boolean; accountEmail?: string | null; authEnabled: boolean; sessionLoading?: boolean }) {
  const params = useSearchParams();
  const purchase = params.get("purchase");
  const sessionId = params.get("session_id");

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<{ state: "pending" | "granted" | "slow"; credits?: number; expiresAt?: string } | null>(
    purchase === "success" && sessionId ? { state: "pending" } : null,
  );

  const loadWorkspace = useCallback(async () => {
    try {
      const [statusRes, creditsRes] = await Promise.all([
        fetch("/api/billing/status", { cache: "no-store" }),
        fetch("/api/credits/snapshot?fast=1&bust=1", { cache: "no-store" }),
      ]);
      const status = (await statusRes.json().catch(() => null)) as { plan?: string; org?: { name?: string | null } } | null;
      const credits = (await creditsRes.json().catch(() => null)) as { creditsRemaining?: unknown } | null;
      if (!statusRes.ok || !status) return;
      setWorkspace({
        name: status.org?.name ?? null,
        plan: status.plan === "pro" ? "pro" : "free",
        credits: creditsRes.ok && typeof credits?.creditsRemaining === "number" ? credits.creditsRemaining : null,
      });
    } catch {
      // The page still sells packs without the balance line.
    }
  }, []);

  useEffect(() => {
    if (signedIn) void loadWorkspace();
  }, [signedIn, loadWorkspace]);

  // After Stripe: wait for the webhook's grant rather than trusting the redirect.
  useEffect(() => {
    if (!signedIn || purchase !== "success" || !sessionId) return;
    let cancelled = false;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const res = await fetch(`/api/credits/purchase?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { status?: string; credits?: number; expiresAt?: string } | null;
        if (cancelled) return;
        if (res.ok && json?.status === "granted") {
          setGrant({ state: "granted", credits: json.credits, expiresAt: json.expiresAt });
          void loadWorkspace();
          return;
        }
      } catch {
        // keep polling
      }
      if (cancelled) return;
      if (tries === 20) setGrant({ state: "slow" });
      timer = window.setTimeout(tick, tries < 20 ? 1500 : 5000);
    };
    let timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [signedIn, purchase, sessionId, loadWorkspace]);

  async function buy(pack: CreditPack) {
    if (busyPack) return;
    setError(null);
    setBusyPack(pack.id);
    if (!signedIn) {
      void signIn("google", { callbackUrl: "/credits" });
      return;
    }
    try {
      const res = await fetch("/api/credits/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId: pack.id }),
      });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) throw new Error(json?.error || "Could not start checkout");
      window.location.assign(json.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout");
      setBusyPack(null);
    }
  }

  const best = packs.reduce((a, b) => (b.priceCents / b.credits < a.priceCents / a.credits ? b : a));
  const showPro = !(signedIn && workspace?.plan === "pro");

  return (
    <>
      {grant || purchase === "canceled" ? (
        <div
          role="status"
          className="mt-10 flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-sm leading-6 text-white/75"
        >
          {grant?.state === "pending" ? <Spinner className="mt-1 h-4 w-4 shrink-0 text-white/60" label={null} /> : null}
          <div>
            {grant?.state === "granted" ? (
              <>
                <span className="font-semibold text-white">{grant.credits} credits added.</span>{" "}
                {grant.expiresAt ? `Whatever is left of them expires on ${formatShortDate(grant.expiresAt)}.` : null}{" "}
                <Link href="/dashboard/usage" className="underline underline-offset-4 hover:text-white">
                  See usage
                </Link>
              </>
            ) : grant?.state === "slow" ? (
              "Payment received. Your credits are taking longer than usual to appear; this page updates as soon as they do."
            ) : grant?.state === "pending" ? (
              "Payment received. Adding your credits…"
            ) : (
              "Checkout canceled. Nothing was charged."
            )}
          </div>
        </div>
      ) : null}

      {/*
        Say whose balance this is. It read `“Personal” has 9 credits.` — a bare quoted name with no
        owner, which a reader takes for placeholder text rather than their own workspace. Naming the
        account underneath also answers the question a purchase page actually raises: if I pay, where
        do the credits land.
      */}
      <div className="mt-10 min-h-5 text-sm text-white/55">
        {signedIn && workspace ? (
          <>
            <div>
              Your workspace <span className="font-semibold text-white">{workspace.name ?? "Personal"}</span> has{" "}
              <span className="font-semibold tabular-nums text-white">{workspace.credits ?? "—"}</span> credits.
            </div>
            <div className="mt-1 text-white/40">
              {accountEmail ? <>Signed in as {accountEmail}. Credits</> : <>Credits</>} you buy are added to this workspace.
            </div>
          </>
        ) : !signedIn && !sessionLoading && authEnabled ? (
          "Sign in to buy credits for your workspace."
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3 md:gap-5">
        {packs.map((pack) => {
          const busy = busyPack === pack.id;
          return (
            <div key={pack.id} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
              <div className="flex min-h-[24px] items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">{pack.credits} credits</div>
                {pack.id === best.id ? (
                  <span className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">
                    Best value
                  </span>
                ) : null}
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="font-serif text-5xl tracking-tight text-white">{formatPackPrice(pack.priceCents)}</span>
                <span className="text-sm text-white/50">one time</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-white/60">
                {formatPerCredit(pack)} a credit. About {pack.credits} link summaries, or {Math.floor(pack.credits / 5)} AI
                compares at standard quality.
              </p>
              <div className="mt-8 flex-1" />
              <button
                type="button"
                className={BUTTON}
                disabled={!authEnabled || Boolean(busyPack)}
                aria-busy={busy}
                onClick={() => void buy(pack)}
              >
                <span className={busy ? "invisible" : ""}>Buy {pack.credits} credits</span>
                {busy ? (
                  <span className="absolute inset-0 grid place-items-center">
                    <Spinner className="h-4 w-4" label="Opening checkout" />
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {showPro ? (
        <div className="mt-5 grid gap-6 rounded-2xl bg-white p-7 text-black shadow-[0_30px_80px_-30px_rgba(255,255,255,0.25)] sm:p-8 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:items-center md:gap-12">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-black/55">Or get Pro</div>
            <h2 className="mt-3 font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
              {proCredits} credits every month{proPriceLabel ? `, for ${proPriceLabel}` : ""}.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-black/60">
              Buying credits more than once a month? A month of Pro costs less than the {best.credits}-credit pack, and
              adds unlimited documents and projects, deep analytics on who read what, and a collaborator.
            </p>
          </div>
          <div className={cn("w-full")}>
            <PricingCta plan="pro" variant="light" helper="Stripe checkout · Cancel anytime" />
          </div>
        </div>
      ) : null}
    </>
  );
}
