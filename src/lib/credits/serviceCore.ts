import type { ActionType, CreditBucket, LedgerStatus, QualityTier } from "@/lib/credits/types";
import { creditsForRun } from "@/lib/credits/schedule";
import type { CreditStore, WorkspaceBalanceSnapshot } from "@/lib/credits/store";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { onDemandEligible } from "@/lib/billing/subscriptionState";

/**
 * Default on-demand eligibility check: the workspace must be on **monthly** Pro (`active` or
 * `trialing`, Pro price, billed monthly). On-demand is Pro's overage; Free workspaces buy credit
 * packs instead, so a legacy pay-as-you-go subscription (a Free workspace with a card on file) is
 * not eligible. Neither is yearly Pro: Stripe will not attach the monthly metered price to a
 * yearly subscription, so there is no line item that could bill the usage. This asked
 * `isProSubscription` and ignored `interval`, so a row switched to yearly with `onDemandEnabled`
 * still set kept allocating on-demand credits that nothing invoiced.
 *
 * Only invoked when the balance has on-demand enabled AND the run would actually spill into
 * on-demand credits, so the extra query is paid rarely. Callers (tests) may inject their own
 * check via `isOnDemandEligible`.
 */
async function defaultIsProWorkspace(workspaceId: string): Promise<boolean> {
  const sub = await SubscriptionModel.findOne({ orgId: workspaceId, isDeleted: { $ne: true } })
    .select({ status: 1, kind: 1, interval: 1 })
    .lean();
  return onDemandEligible(sub as { status?: unknown; kind?: unknown; interval?: unknown } | null);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function utcDayKey(d: Date): string {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

function cycleKeyForUsage(params: { workspaceId: string; cycleStart: Date }): string {
  // Stable per-workspace per-cycle key. (Does not rely on Stripe ids.)
  return `${params.workspaceId}:${params.cycleStart.toISOString()}`;
}

function clampNonNegInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function tierCap(balance: WorkspaceBalanceSnapshot, q: QualityTier): number {
  if (q === "advanced") return clampNonNegInt(balance.perRunCreditCapAdvanced ?? 150);
  if (q === "standard") return clampNonNegInt(balance.perRunCreditCapStandard ?? 60);
  return clampNonNegInt(balance.perRunCreditCapBasic ?? 20);
}

function allocateBuckets(params: {
  credits: number;
  balance: { trial: number; subscription: number; purchased: number };
  onDemandAllowed: boolean;
}): { ok: true; byBucket: Record<CreditBucket, number> } | { ok: false; error: string } {
  const need = clampNonNegInt(params.credits);
  const out: Record<CreditBucket, number> = { trial: 0, subscription: 0, purchased: 0, on_demand: 0 };
  let remaining = need;

  const take = (bucket: Exclude<CreditBucket, "on_demand">, available: number) => {
    if (remaining <= 0) return;
    const n = Math.min(remaining, clampNonNegInt(available));
    out[bucket] += n;
    remaining -= n;
  };

  // Consumption order (source-of-truth):
  // 1) burn included credits first (subscription cycle credits)
  // 2) then burn paid/on-demand credits
  // For free workspaces, subscription is typically 0 so trial is used naturally.
  take("subscription", params.balance.subscription);
  take("trial", params.balance.trial);
  take("purchased", params.balance.purchased);

  if (remaining > 0) {
    if (!params.onDemandAllowed) return { ok: false, error: "Insufficient credits" };
    out.on_demand = remaining;
    remaining = 0;
  }

  return { ok: true, byBucket: out };
}

export function createCreditService(store: CreditStore) {
  async function reserveCreditsOrThrow(params: {
    workspaceId: string;
    userId: string;
    docId?: string | null;
    actionType: ActionType;
    qualityTier: QualityTier;
    idempotencyKey: string;
    requestId?: string | null;
    initBalanceIfMissing: () => Promise<WorkspaceBalanceSnapshot>;
    /**
     * Optional override for the on-demand eligibility check (defaults to requiring Pro, `active` or
     * `trialing`). Injected by tests.
     */
    isOnDemandEligible?: (workspaceId: string) => Promise<boolean>;
    /** Optional override for the Pro check that exempts a workspace from the Free daily brake. Injected by tests. */
    isProWorkspace?: (workspaceId: string) => Promise<boolean>;
  }): Promise<{
    ledgerId: string;
    status: LedgerStatus;
    creditsReserved: number;
    creditsEstimated: number;
  }> {
    const idempotencyKey = (params.idempotencyKey ?? "").trim();
    if (!idempotencyKey) throw new Error("Missing idempotencyKey");

    const creditsEstimated = creditsForRun({ actionType: params.actionType, qualityTier: params.qualityTier });
    const creditsReserved = creditsEstimated;

    return store.withTransaction(async () => {
      const existing = await store.getLedgerByIdempotencyKey({
        workspaceId: params.workspaceId,
        idempotencyKey,
      });
      if (existing) {
        return {
          ledgerId: existing.id,
          status: existing.status,
          creditsReserved: clampNonNegInt(existing.creditsReserved),
          creditsEstimated: clampNonNegInt(existing.creditsEstimated),
        };
      }

      const now = new Date();
      const balance = await store.getOrCreateBalance({
        workspaceId: params.workspaceId,
        initIfMissing: params.initBalanceIfMissing,
      });

      const nextBalance: WorkspaceBalanceSnapshot = { ...balance };

      // Subscription credits expire at period end.
      if (nextBalance.currentPeriodEnd && now.getTime() > nextBalance.currentPeriodEnd.getTime()) {
        nextBalance.subscriptionCreditsRemaining = 0;
      }

      const cycleStart = nextBalance.currentPeriodStart ?? startOfUtcMonth(now);
      const cycleEnd = nextBalance.currentPeriodEnd ?? null;
      const cycleKey = cycleKeyForUsage({ workspaceId: params.workspaceId, cycleStart });

      // Per-run cap.
      const cap = tierCap(nextBalance, params.qualityTier);
      if (creditsReserved > cap) throw new Error("Per-run credit cap exceeded");

      const sums = await store.getUsageSums({ workspaceId: params.workspaceId, now, cycleStart });

      if (nextBalance.dailyCreditCap !== null) {
        const dayStart = startOfUtcDay(now);
        void dayStart; // used by store impl; present here for conceptual clarity
        // The daily brake is Free-only, but it is stored on the balance row when the row is seeded
        // and nothing cleared it on upgrade, so a workspace that started Free and moved to Pro kept
        // hitting it. Ask about the plan only when the brake would actually stop this run.
        if (
          clampNonNegInt(sums.dailyReserved) + creditsReserved > clampNonNegInt(nextBalance.dailyCreditCap) &&
          !(await (params.isProWorkspace ?? defaultIsProWorkspace)(params.workspaceId))
        ) {
          throw new Error("Daily credit cap exceeded");
        }
      }

      if (nextBalance.monthlyCreditCap !== null) {
        const monthStart = startOfUtcMonth(now);
        void monthStart;
        if (clampNonNegInt(sums.monthlyReserved) + creditsReserved > clampNonNegInt(nextBalance.monthlyCreditCap)) {
          throw new Error("Monthly credit cap exceeded");
        }
      }

      // On-demand requires: workspace toggle on, a positive monthly limit, AND an active/trialing
      // subscription (a canceled/unpaid workspace must never accrue metered overage). The
      // subscription lookup is only made when the run would actually need on-demand credits.
      const onDemandConfigured =
        Boolean(nextBalance.onDemandEnabled) && clampNonNegInt(nextBalance.onDemandMonthlyLimitCents) > 0;
      const prepaidAvailable =
        clampNonNegInt(nextBalance.trialCreditsRemaining) +
        clampNonNegInt(nextBalance.subscriptionCreditsRemaining) +
        clampNonNegInt(nextBalance.purchasedCreditsRemaining);
      const needsOnDemand = creditsReserved > prepaidAvailable;
      const onDemandAllowed =
        onDemandConfigured &&
        needsOnDemand &&
        (await (params.isOnDemandEligible ?? defaultIsProWorkspace)(params.workspaceId));
      const alloc = allocateBuckets({
        credits: creditsReserved,
        balance: {
          trial: clampNonNegInt(nextBalance.trialCreditsRemaining),
          subscription: clampNonNegInt(nextBalance.subscriptionCreditsRemaining),
          purchased: clampNonNegInt(nextBalance.purchasedCreditsRemaining),
        },
        onDemandAllowed,
      });
      if (!alloc.ok) throw new Error(alloc.error);

      // On-demand monthly limit: enforce only on on-demand portion.
      if (alloc.byBucket.on_demand > 0) {
        const centsPerCredit = USD_CENTS_PER_CREDIT;
        const nextCents = (clampNonNegInt(sums.monthlyOnDemandReserved) + alloc.byBucket.on_demand) * centsPerCredit;
        if (nextCents > clampNonNegInt(nextBalance.onDemandMonthlyLimitCents)) {
          throw new Error("On-demand monthly limit exceeded");
        }
      }

      // Apply decrements.
      nextBalance.trialCreditsRemaining = clampNonNegInt(nextBalance.trialCreditsRemaining) - alloc.byBucket.trial;
      nextBalance.subscriptionCreditsRemaining =
        clampNonNegInt(nextBalance.subscriptionCreditsRemaining) - alloc.byBucket.subscription;
      nextBalance.purchasedCreditsRemaining =
        clampNonNegInt(nextBalance.purchasedCreditsRemaining) - alloc.byBucket.purchased;

      await store.saveBalance({ workspaceId: params.workspaceId, next: nextBalance });

      const created = await store.createPendingLedger({
        workspaceId: params.workspaceId,
        userId: params.userId,
        docId: params.docId ?? null,
        actionType: params.actionType,
        qualityTier: params.qualityTier,
        idempotencyKey,
        requestId: params.requestId ?? null,
        creditsEstimated,
        creditsReserved,
        creditsFrom: alloc.byBucket,
        cycleKey,
        cycleStart,
        cycleEnd,
        day: utcDayKey(now),
      });

      return {
        ledgerId: created.id,
        status: "pending",
        creditsReserved,
        creditsEstimated,
      };
    });
  }

  async function markLedgerCharged(params: {
    ledgerId: string;
    creditsCharged: number;
    telemetry?: Record<string, unknown> | null;
  }): Promise<void> {
    await store.setLedgerStatus({
      ledgerId: params.ledgerId,
      status: "charged",
      creditsCharged: clampNonNegInt(params.creditsCharged),
      telemetry: params.telemetry ?? null,
    });
  }

  async function failAndRefundLedger(params: { ledgerId: string }): Promise<void> {
    await store.withTransaction(async () => {
      const ledger = await store.getLedgerById({ ledgerId: params.ledgerId });
      if (!ledger) return;
      if (ledger.status !== "pending") return;

      const balance = await store.getOrCreateBalance({
        workspaceId: ledger.workspaceId,
        initIfMissing: async () => ({
          trialCreditsRemaining: 0,
          subscriptionCreditsRemaining: 0,
          purchasedCreditsRemaining: 0,
          onDemandEnabled: false,
          onDemandMonthlyLimitCents: 0,
          dailyCreditCap: null,
          monthlyCreditCap: null,
          perRunCreditCapBasic: 20,
          perRunCreditCapStandard: 60,
          perRunCreditCapAdvanced: 150,
          currentPeriodStart: null,
          currentPeriodEnd: null,
        }),
      });
      const next: WorkspaceBalanceSnapshot = { ...balance };
      next.trialCreditsRemaining += clampNonNegInt(ledger.creditsFrom.trial);
      next.subscriptionCreditsRemaining += clampNonNegInt(ledger.creditsFrom.subscription);
      next.purchasedCreditsRemaining += clampNonNegInt(ledger.creditsFrom.purchased);
      await store.saveBalance({ workspaceId: ledger.workspaceId, next });

      await store.setLedgerStatus({ ledgerId: params.ledgerId, status: "failed", creditsCharged: 0 });
    });
  }

  return { reserveCreditsOrThrow, markLedgerCharged, failAndRefundLedger };
}


