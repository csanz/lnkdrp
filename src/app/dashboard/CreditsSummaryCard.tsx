/**
 * Credits summary card for `/dashboard?tab=usage`.
 *
 * Shows remaining credits for every plan. On Pro the included tile is the monthly allowance and the
 * header carries the billing cycle reset date (Stripe period end); on Free (plan read from
 * `/api/billing/status`) the included tile is the one-time starter grant and there is no reset date.
 */
"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import Alert from "@/components/ui/Alert";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { formatShortDate } from "@/lib/format/date";
import { formatUsdFromCents } from "@/lib/format/money";
import { CREDITS_SNAPSHOT_REFRESH_EVENT } from "@/lib/client/creditsSnapshotRefresh";
import { CREDITS_COPY, FEATURE_CREDITS_ENABLED, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { CREDIT_PACKS, PURCHASED_CREDITS_EXPIRY_MONTHS, formatPackPrice } from "@/lib/credits/packs";

type CreditsSnapshot = {
  ok: true;
  creditsRemaining: number;
  includedRemaining: number;
  paidRemaining: number;
  usedThisCycle: number;
  cycleEnd: string | null;
  includedThisCycle?: number | null;
  /** Always `null` since the Free monthly floor was removed (2026-09-15); kept so old clients still parse. */
  resetsAt?: string | null;
  onDemandMonthlyLimitCents?: number;
  onDemandUsedCreditsThisCycle?: number;
};

/** Workspace plan from `/api/billing/status`; `null` while loading, `"unknown"` when the read failed. */
type PlanState = "free" | "pro" | "unknown" | null;

/**
 * Credits summary card; on by default, renders nothing only when `NEXT_PUBLIC_FEATURE_CREDITS=0`.
 */
export default function CreditsSummaryCard(props: { headerRightSlot?: ReactNode }) {
  if (!FEATURE_CREDITS_ENABLED) return null;
  return <CreditsSummaryCardInner {...props} />;
}

const PRIMARY_LINK =
  "inline-flex items-center justify-center rounded-lg bg-[var(--fg)] px-3 py-2 text-[12px] font-semibold text-[var(--bg)]";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]";
const CHEAPEST_PACK_PRICE = formatPackPrice(Math.min(...CREDIT_PACKS.map((p) => p.priceCents)));

/** Credits summary body: remaining / included / extra / used tiles plus the out-of-credits prompt. */
function CreditsSummaryCardInner({
  headerRightSlot,
}: {
  headerRightSlot?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CreditsSnapshot | null>(null);
  const [plan, setPlan] = useState<PlanState>(null);
  const { openUpgrade } = useUpgradeModal();

  // The plan picks the labels (starter grant vs monthly allowance). A failed read falls back to the
  // Pro labels ("unknown") rather than hiding a workspace's balance.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/billing/status", { method: "GET" });
        const json = (await res.json().catch(() => null)) as { plan?: unknown } | null;
        const p = res.ok && json && typeof json.plan === "string" ? json.plan.trim().toLowerCase() : "";
        if (!cancelled) setPlan(p === "free" || p === "pro" ? p : "unknown");
      } catch {
        if (!cancelled) setPlan("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/credits/snapshot", { method: "GET" });
        const json = (await res.json().catch(() => null)) as CreditsSnapshot | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || (json as any).ok !== true) throw new Error("Invalid response");
        if (!cancelled) setData(json as CreditsSnapshot);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load credits");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void load();
    const onRefresh = () => void load();
    window.addEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    };
  }, []);

  const creditsRemaining = typeof data?.creditsRemaining === "number" ? Math.max(0, Math.floor(data.creditsRemaining)) : null;
  const includedRemaining = typeof data?.includedRemaining === "number" ? Math.max(0, Math.floor(data.includedRemaining)) : null;
  const paidRemaining = typeof data?.paidRemaining === "number" ? Math.max(0, Math.floor(data.paidRemaining)) : null;
  const usedThisCycle = typeof data?.usedThisCycle === "number" ? Math.max(0, Math.floor(data.usedThisCycle)) : null;
  const reset = typeof data?.cycleEnd === "string" ? data.cycleEnd : null;
  const includedThisCycle =
    typeof data?.includedThisCycle === "number" && Number.isFinite(data.includedThisCycle)
      ? Math.max(0, Math.floor(data.includedThisCycle))
      : null;
  const onDemandEnabled = typeof data?.onDemandMonthlyLimitCents === "number" && data.onDemandMonthlyLimitCents > 0;
  const onDemandUnlimited = typeof data?.onDemandMonthlyLimitCents === "number" && data.onDemandMonthlyLimitCents >= UNLIMITED_LIMIT_CENTS;
  const onDemandUsed = typeof data?.onDemandUsedCreditsThisCycle === "number" ? Math.max(0, Math.floor(data.onDemandUsedCreditsThisCycle)) : null;

  const centsPerCredit = USD_CENTS_PER_CREDIT;
  const usedCentsThisCycle = usedThisCycle !== null ? usedThisCycle * centsPerCredit : null;
  const isFree = plan === "free";
  // Free: the snapshot reports the starter grant while any of it remains; once it is spent the
  // grant is still 50, so keep the label honest instead of showing a dash.
  const starterGrant = includedThisCycle ?? CREDITS_COPY.freeStarter;

  if (plan === null) {
    // Plan still loading: keep the header and a quiet placeholder so the labels never flip.
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[13px] font-semibold text-[var(--fg)]">Credits</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Loading…</div>
          </div>
          {headerRightSlot ? <div className="shrink-0">{headerRightSlot}</div> : null}
        </div>
        <div className="mt-5 h-[76px] animate-pulse rounded-xl bg-[var(--panel-2)]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Credits</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            {busy
              ? "Loading…"
              : isFree
                ? `${CREDITS_COPY.freeStarter} starter credits, one time. Once they run out, ${whatHappensAfterFreeCredits()}.`
                : reset
                  ? `Credits reset on ${formatShortDate(reset, { invalid: "raw" })}.`
                  : "Reset date unavailable."}
          </div>
        </div>
        {headerRightSlot ? <div className="shrink-0">{headerRightSlot}</div> : <div className="text-[12px] text-[var(--muted-2)]">{busy ? "…" : null}</div>}
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl bg-[var(--panel-2)] p-4 lg:col-span-2">
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">Credits remaining</div>
          <div className="mt-2 text-[26px] font-semibold tracking-tight text-[var(--fg)]">
            {creditsRemaining === null ? (
              "—"
            ) : onDemandUnlimited ? (
              <span className="inline-flex items-baseline gap-2">
                <span className="text-emerald-700 dark:text-emerald-300">∞</span>
                <span className="text-[12px] font-semibold text-[var(--muted-2)]">Unlimited</span>
              </span>
            ) : (
              creditsRemaining.toLocaleString()
            )}
          </div>
        </div>
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">{isFree ? "Starter" : "Included"}</div>
          <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">{includedRemaining !== null ? includedRemaining.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            {isFree ? `${starterGrant.toLocaleString()} to start, one time` : `Per month: ${includedThisCycle !== null ? includedThisCycle.toLocaleString() : "—"}`}
          </div>
        </div>
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">Extra</div>
          <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">
            {paidRemaining === null ? (
              "—"
            ) : onDemandUnlimited ? (
              <span className="text-emerald-700 dark:text-emerald-300">∞</span>
            ) : (
              paidRemaining.toLocaleString()
            )}
          </div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">{isFree ? "Purchased credits" : "Purchased + on-demand headroom"}</div>
        </div>
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">Used</div>
          <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">{usedThisCycle !== null ? usedThisCycle.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            This month{usedCentsThisCycle !== null ? ` • ≈ ${formatUsdFromCents(usedCentsThisCycle)} @ $0.10/credit` : ""}
          </div>
        </div>
      </div>

      {onDemandEnabled && onDemandUsed !== null ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          On-demand used: <span className="font-semibold text-[var(--fg)]">{onDemandUsed.toLocaleString()}</span> credits
        </div>
      ) : null}

      {/* A way to get more credits at any balance, not only once they are gone (the out-of-credits
          box below takes over at zero). */}
      {creditsRemaining !== 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
          <div className="min-w-0 text-[12px] text-[var(--muted-2)]">
            <span className="font-semibold text-[var(--fg)]">Need more credits?</span> Buy a pack from {CHEAPEST_PACK_PRICE},
            used after your {isFree ? "starter" : "included"} credits and valid for {PURCHASED_CREDITS_EXPIRY_MONTHS} months.
          </div>
          <Link href="/credits" className={PRIMARY_LINK}>
            Add more credits
          </Link>
        </div>
      ) : null}

      {creditsRemaining === 0 ? (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--fg)]">Out of credits</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            {isFree
              ? `You’re out of credits. Uploads and links still work; the AI summary is skipped and you can write it later from the document page. Buy a credit pack from ${CHEAPEST_PACK_PRICE}, or upgrade to Pro for ${CREDITS_COPY.proPerMonth} a month included and AI compare on every replacement.`
              : "You’ve used all available credits. Uploads and links still work; the AI summary is skipped and you can write it later from the document page. AI compare is unavailable until credits reset, you buy a credit pack, or you enable on-demand."}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href="/credits" className={PRIMARY_LINK}>
              Add more credits
            </Link>
            {isFree ? (
              <button type="button" className={SECONDARY} onClick={() => openUpgrade("credits")}>
                Upgrade to Pro
              </button>
            ) : (
              <Link href="/dashboard/limits" className={SECONDARY}>
                {onDemandEnabled ? "Increase limit" : "Manage credits"}
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}


