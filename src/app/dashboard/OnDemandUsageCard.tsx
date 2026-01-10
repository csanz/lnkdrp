/**
 * On-demand usage card for the Dashboard Limits tab.
 *
 * Credits-first view of on-demand usage within the current billing cycle.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { clampNonNegInt } from "@/lib/format/number";
import { formatUsdFromCents } from "@/lib/format/money";
import { SPEND_LIMIT_UPDATED_EVENT, getCachedSpendStatus, refreshSpendStatus } from "./SpendLimitModule";

type SpendStatus = {
  ok: true;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  onDemandUsedCentsThisCycle: number;
};

export default function OnDemandUsageCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SpendStatus | null>(() => (getCachedSpendStatus() as SpendStatus | null) ?? null);

  useEffect(() => {
    let cancelled = false;
    setBusy(!data);
    setError(null);
    void (async () => {
      try {
        const next = await refreshSpendStatus();
        if (!cancelled) setData(next as SpendStatus);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load on-demand usage");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    const onUpdated = () => {
      void (async () => {
        try {
          const next = await refreshSpendStatus({ force: true });
          if (!cancelled) setData(next as SpendStatus);
        } catch {
          // ignore; keep last-known data
        }
      })();
    };
    window.addEventListener(SPEND_LIMIT_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(SPEND_LIMIT_UPDATED_EVENT, onUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const centsPerCredit = USD_CENTS_PER_CREDIT;
  const limitCents = clampNonNegInt(data?.onDemandMonthlyLimitCents ?? 0);
  const usedCents = clampNonNegInt(data?.onDemandUsedCentsThisCycle ?? 0);
  const enabled = Boolean(data?.onDemandEnabled) && limitCents > 0;
  const unlimited = enabled && limitCents >= UNLIMITED_LIMIT_CENTS;

  const limitCredits = enabled ? Math.floor(limitCents / centsPerCredit) : 0;
  const usedCredits = enabled ? Math.floor(usedCents / centsPerCredit) : 0;

  const progress = useMemo(() => {
    if (!enabled || limitCredits <= 0 || unlimited) return 0;
    return Math.max(0, Math.min(1, usedCredits / limitCredits));
  }, [enabled, usedCredits, limitCredits, unlimited]);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] font-semibold text-[var(--fg)]">On-demand usage</div>
        <HelpTooltip
          label="What is on-demand usage?"
          body="On-demand usage is extra credit headroom you can enable beyond your included plan credits. Your on-demand limit resets each billing cycle."
        />
      </div>
      <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
        {busy && !data ? "Loading…" : !enabled ? "Disabled." : "This billing cycle."}
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <div className="mt-4 rounded-xl bg-[var(--panel-2)] p-4">
        <div className="text-[12px] font-semibold text-[var(--muted-2)]">Credits</div>
        <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">
          {enabled ? (
            unlimited ? (
              <>
                {usedCredits.toLocaleString()} / <span className="text-emerald-700 dark:text-emerald-300">∞</span>
              </>
            ) : (
              `${usedCredits.toLocaleString()} / ${limitCredits.toLocaleString()}`
            )
          ) : (
            "—"
          )}
        </div>
        <div className="mt-1 text-[12px] text-[var(--muted-2)]">
          {enabled
            ? `${formatUsdFromCents(usedCents)} / ${unlimited ? "Unlimited" : formatUsdFromCents(limitCents)}`
            : "Set a limit to enable on-demand usage."}
        </div>

        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]" aria-hidden="true">
          <div className="h-2 rounded-full bg-[var(--fg)]" style={{ width: `${Math.round(progress * 100)}%`, opacity: 0.55 }} />
        </div>
      </div>
    </div>
  );
}


