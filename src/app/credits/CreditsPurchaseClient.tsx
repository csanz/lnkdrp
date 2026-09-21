/**
 * The interactive part of `/credits`: the workspace's balance, one card per pack, the Pro card, and
 * the confirmation shown when Stripe sends the buyer back.
 *
 * Signed out, a pack button signs in first and returns here. Signed in, it starts a one-time
 * Checkout (`POST /api/credits/purchase`). On return (`?purchase=success&session_id=…`) it polls
 * `GET /api/credits/purchase` until the webhook has granted the credits, since the redirect alone
 * proves nothing. The Pro card is hidden for workspaces already on Pro.
 *
 * Packs are how Free adds credits. A signed-in Pro workspace sees no packs (the API refuses them):
 * it gets its credits and on-demand usage instead, with a way into Limits, since on-demand is how
 * Pro keeps going past its monthly credits, at a lower per-credit price than any pack.
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
import { formatUsdFromCents } from "@/lib/format/money";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { cn } from "@/lib/cn";
import WorkspaceIcon from "@/components/WorkspaceIcon";

type Props = { packs: CreditPack[]; proPriceLabel: string | null; proCredits: number; freeCredits: number };

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

type Workspace = {
  name: string | null;
  avatarUrl: string | null;
  plan: "free" | "pro";
  /** Credits held: included + starter + purchased. Never on-demand headroom. */
  credits: number | null;
  purchased: number | null;
  /** Pro only (the snapshot reports it off elsewhere). */
  onDemand: { limitCents: number; usedCredits: number } | null;
  /** Pro only: when the subscription renews, or ends if `cancelAtPeriodEnd`. */
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

function Body({
  packs,
  proPriceLabel,
  proCredits,
  freeCredits,
  signedIn,
  accountEmail = null,
  authEnabled,
  sessionLoading = false,
}: Props & { signedIn: boolean; accountEmail?: string | null; authEnabled: boolean; sessionLoading?: boolean }) {
  const params = useSearchParams();
  const purchase = params.get("purchase");
  const sessionId = params.get("session_id");

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
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
      const status = (await statusRes.json().catch(() => null)) as {
        plan?: string;
        org?: { name?: string | null; avatarUrl?: string | null };
        stripeCurrentPeriodEnd?: string | null;
        stripeCancelAtPeriodEnd?: boolean;
      } | null;
      const credits = (await creditsRes.json().catch(() => null)) as {
        creditsRemaining?: unknown;
        purchasedRemaining?: unknown;
        onDemandMonthlyLimitCents?: unknown;
        onDemandUsedCreditsThisCycle?: unknown;
      } | null;
      if (!statusRes.ok || !status) {
        setWorkspaceFailed(true);
        return;
      }
      const num = (v: unknown) => (creditsRes.ok && typeof v === "number" ? v : null);
      const plan = status.plan === "pro" ? "pro" : "free";
      setWorkspace({
        name: status.org?.name ?? null,
        avatarUrl: status.org?.avatarUrl ?? null,
        plan,
        credits: num(credits?.creditsRemaining),
        purchased: num(credits?.purchasedRemaining),
        onDemand:
          plan === "pro" && creditsRes.ok
            ? { limitCents: num(credits?.onDemandMonthlyLimitCents) ?? 0, usedCredits: num(credits?.onDemandUsedCreditsThisCycle) ?? 0 }
            : null,
        periodEnd: status.stripeCurrentPeriodEnd ?? null,
        cancelAtPeriodEnd: Boolean(status.stripeCancelAtPeriodEnd),
      });
    } catch {
      // The page still sells packs without the balance line.
      setWorkspaceFailed(true);
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
  const isProWorkspace = signedIn && workspace?.plan === "pro";
  const showPro = !isProWorkspace;
  // Signed in: wait for the plan before showing packs, so a Pro workspace never flashes them.
  const showPacks = !signedIn || workspaceFailed || workspace?.plan === "free";
  const packsPending = signedIn && !workspace && !workspaceFailed;

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
        Whose account and workspace a purchase lands in. This was one muted sentence ("Your workspace
        Personal has 9 credits"), easy to read past on a page whose whole job is to charge a card — and
        with no way to change the workspace short of leaving to find the switcher. It is now a panel:
        who is signed in, which workspace, its plan, where the balance comes from, and a way to switch
        before buying. Credits cannot move between workspaces afterwards, so this is the moment to check.
      */}
      {signedIn && workspace ? (
        <WorkspacePanel workspace={workspace} accountEmail={accountEmail} proCredits={proCredits} freeCredits={freeCredits} />
      ) : !signedIn && !sessionLoading && authEnabled ? (
        <Link
          href="/login?next=%2Fcredits"
          className="group mt-10 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-5 text-sm text-white/65 transition hover:border-white/20 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
        >
          <span>Sign in to see your workspace’s balance and buy credits for it.</span>
          <span className="shrink-0 font-semibold text-white group-hover:underline group-hover:underline-offset-4">
            Sign in →
          </span>
        </Link>
      ) : (
        <div className="mt-10 h-[196px] rounded-2xl border border-white/10 bg-white/[0.02]" aria-hidden="true" />
      )}

      {isProWorkspace && workspace ? <OnDemandCard workspace={workspace} proCredits={proCredits} /> : null}
      {packsPending ? <div className="mt-4 h-[260px] rounded-2xl border border-white/10 bg-white/[0.02]" aria-hidden="true" /> : null}

      <div className={cn("mt-4 grid gap-4 md:grid-cols-3 md:gap-5", !showPacks && "hidden")}>
        {packs.map((pack) => {
          const busy = busyPack === pack.id;
          return (
            <div key={pack.id} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
              <div className="flex min-h-[24px] items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">{pack.credits} credits</div>
                {pack.id === best.id ? (
                  <span className="rounded-full border border-white/15 px-2.5 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">
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

const PANEL_LINK =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60";

/** The signed-in account, the workspace a purchase lands in, and where its balance comes from. */
function WorkspacePanel({
  workspace,
  accountEmail,
  proCredits,
  freeCredits,
}: {
  workspace: Workspace;
  accountEmail: string | null;
  proCredits: number;
  freeCredits: number;
}) {
  const name = workspace.name ?? "Personal";
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  const isPro = workspace.plan === "pro";
  const planLabel = isPro ? "Pro" : "Free";
  // What the plan grants, not what is left of it: "Included with Free: 9" read as a live counter
  // and hid the 50 the account actually came with. What is left is the first column's job.
  const planCredits = isPro ? proCredits : freeCredits;
  const planDetail = isPro
    ? workspace.periodEnd
      ? `Every month · ${workspace.cancelAtPeriodEnd ? "ends" : "renews"} ${formatShortDate(workspace.periodEnd)}`
      : "Every month"
    : "One time, when the workspace was created";

  return (
    <section
      aria-label="Your workspace"
      className="mt-10 overflow-hidden rounded-2xl border border-white/20 bg-white/[0.05] shadow-[0_24px_60px_-30px_rgba(0,0,0,0.8)]"
    >
      <div className="flex flex-wrap items-center gap-4 px-6 py-5">
        <WorkspaceIcon
          avatarUrl={workspace.avatarUrl}
          fallback={initial}
          className="h-11 w-11 ring-1 ring-white/15"
          fallbackClassName="bg-white/10 text-base text-white"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
            {isPro ? "Credits for" : "Buying credits for"}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold text-white">{name}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
                isPro ? "bg-white text-black" : "bg-white/10 text-white/80 ring-1 ring-white/15",
              )}
            >
              {planLabel}
            </span>
          </div>
          {accountEmail ? <div className="mt-0.5 truncate text-[13px] text-white/50">Signed in as {accountEmail}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard?tab=workspace" className={PANEL_LINK}>
            Switch workspace
          </Link>
          <Link href="/dashboard?tab=billing" className={PANEL_LINK}>
            {isPro ? "Manage plan" : "Billing"}
          </Link>
        </div>
      </div>

      <dl className="grid grid-cols-1 border-t border-white/10 sm:grid-cols-3">
        <div className="px-6 py-4">
          <dt className="text-[12px] text-white/50">Credits left</dt>
          <dd className="mt-1 font-serif text-4xl leading-none tabular-nums text-white">{workspace.credits ?? "—"}</dd>
          {isPro && workspace.purchased ? (
            <div className="mt-2 text-[12px] text-white/45">Includes {workspace.purchased} purchased</div>
          ) : null}
        </div>
        <div className="border-t border-white/10 px-6 py-4 sm:border-l sm:border-t-0">
          <dt className="text-[12px] text-white/50">Included with {isPro ? "Pro" : "Free"}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-white">{planCredits}</dd>
          <div className="mt-1 text-[12px] text-white/45">{planDetail}</div>
        </div>
        {isPro ? (
          <div className="border-t border-white/10 px-6 py-4 sm:border-l sm:border-t-0">
            <dt className="text-[12px] text-white/50">On-demand this cycle</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-white">
              {!workspace.onDemand ? "—" : onDemandLabel(workspace.onDemand)}
            </dd>
            <div className="mt-1 text-[12px] text-white/45">
              {workspace.onDemand && workspace.onDemand.limitCents > 0
                ? `Billed per use at ${formatUsdFromCents(USD_CENTS_PER_CREDIT)} a credit`
                : "Off. AI stops when included credits run out"}
            </div>
          </div>
        ) : (
          <div className="border-t border-white/10 px-6 py-4 sm:border-l sm:border-t-0">
            <dt className="text-[12px] text-white/50">Purchased</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-white">{workspace.purchased ?? "—"}</dd>
            <div className="mt-1 text-[12px] text-white/45">Used after starter credits</div>
          </div>
        )}
      </dl>

      {isPro ? null : (
        <div className="border-t border-white/10 bg-black/20 px-6 py-3 text-[13px] leading-5 text-white/60">
          Packs you buy below go to <span className="font-semibold text-white">{name}</span> and can’t be moved to another
          workspace later. Wrong workspace? Switch first.
        </div>
      )}
    </section>
  );
}

/** "Off", "12 / 500", "12 used" (no limit). Credits, not dollars: the same unit as the rest of the panel. */
function onDemandLabel(onDemand: { limitCents: number; usedCredits: number }): string {
  if (onDemand.limitCents <= 0) return onDemand.usedCredits > 0 ? `${onDemand.usedCredits} used` : "Off";
  if (onDemand.limitCents >= UNLIMITED_LIMIT_CENTS) return `${onDemand.usedCredits} used`;
  return `${onDemand.usedCredits} / ${Math.floor(onDemand.limitCents / USD_CENTS_PER_CREDIT)}`;
}

/**
 * Pro's answer to "more credits": on-demand usage, set up in Limits. Shown in place of the packs,
 * which Pro can't buy (it would pay more per credit than on-demand).
 */
function OnDemandCard({ workspace, proCredits }: { workspace: Workspace; proCredits: number }) {
  const on = Boolean(workspace.onDemand && workspace.onDemand.limitCents > 0);
  const unlimited = on && (workspace.onDemand?.limitCents ?? 0) >= UNLIMITED_LIMIT_CENTS;
  const perCredit = formatUsdFromCents(USD_CENTS_PER_CREDIT);
  return (
    <div className="mt-4 grid gap-6 rounded-2xl bg-white p-7 text-black shadow-[0_30px_80px_-30px_rgba(255,255,255,0.25)] sm:p-8 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:items-center md:gap-12">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-black/55">On-demand usage</div>
        <h2 className="mt-3 font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
          {on ? "On-demand is on." : `Keep going past ${proCredits} credits.`}
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-black/60">
          {on
            ? `Once your monthly credits run out, AI keeps working at ${perCredit} a credit, billed on your next invoice${
                unlimited ? " with no limit" : `, up to ${formatUsdFromCents(workspace.onDemand?.limitCents ?? 0)} a billing cycle`
              }. Change the limit or turn it off any time.`
            : `On Pro you don’t buy packs. Turn on on-demand and AI keeps working after your monthly credits, at ${perCredit} a credit, billed on your next invoice, up to a limit you set.`}
        </p>
      </div>
      <div className="w-full">
        <Link
          href="/dashboard?tab=limits"
          className="inline-flex w-full items-center justify-center rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white transition hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/60"
        >
          {on ? "Change limit" : "Set up on-demand"}
        </Link>
        <div className="mt-2 text-center text-[12px] text-black/50">Owners and admins · in Limits</div>
      </div>
    </div>
  );
}
