/**
 * Credits summary card for `/dashboard?tab=usage`.
 *
 * Shows remaining credits and billing cycle reset date (Stripe period end).
 */
"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { formatShortDate } from "@/lib/format/date";
import { formatUsdFromCents } from "@/lib/format/money";
import { CREDITS_SNAPSHOT_REFRESH_EVENT } from "@/lib/client/creditsSnapshotRefresh";
import { dispatchOutOfCredits } from "@/lib/client/outOfCredits";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";

type CreditsSnapshot = {
  ok: true;
  creditsRemaining: number;
  includedRemaining: number;
  paidRemaining: number;
  usedThisCycle: number;
  cycleEnd: string | null;
  includedThisCycle?: number | null;
  onDemandMonthlyLimitCents?: number;
  onDemandUsedCreditsThisCycle?: number;
};

export default function CreditsSummaryCard({
  headerRightSlot,
}: {
  headerRightSlot?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CreditsSnapshot | null>(null);

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

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Credits</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            {busy
              ? "Loading…"
              : reset
                ? `Cycle resets on ${formatShortDate(reset, { invalid: "raw" })}.`
                : "Cycle reset date unavailable."}
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
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">Included</div>
          <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">{includedRemaining !== null ? includedRemaining.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            Per cycle: {includedThisCycle !== null ? includedThisCycle.toLocaleString() : "—"}
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
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">Purchased + on-demand headroom</div>
        </div>
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--muted-2)]">Used</div>
          <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">{usedThisCycle !== null ? usedThisCycle.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            This cycle{usedCentsThisCycle !== null ? ` • ≈ ${formatUsdFromCents(usedCentsThisCycle)} @ $0.10/credit` : ""}
          </div>
        </div>
      </div>

      {onDemandEnabled && onDemandUsed !== null ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          On-demand used: <span className="font-semibold text-[var(--fg)]">{onDemandUsed.toLocaleString()}</span> credits
        </div>
      ) : null}

      {creditsRemaining === 0 ? (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
          <div className="text-[12px] font-semibold text-[var(--fg)]">Out of credits</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            You’ve used all available credits. AI tools are currently unavailable.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/limits"
              className="inline-flex items-center justify-center rounded-lg bg-[var(--fg)] px-3 py-2 text-[12px] font-semibold text-[var(--bg)]"
            >
              {onDemandEnabled ? "Increase limit" : "Manage credits"}
            </Link>
            <Button
              variant="outline"
              className="text-[12px]"
              onClick={() => {
                try {
                  dispatchOutOfCredits();
                } catch {
                  // ignore
                }
              }}
            >
              Show modal
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}


