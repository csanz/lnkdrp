import type { ActionType, CreditBucket, LedgerStatus, QualityTier } from "@/lib/credits/types";

export type CreditLedgerStub = {
  id: string;
  status: LedgerStatus;
  creditsReserved: number;
  creditsEstimated: number;
};

export type CreditLedgerFull = CreditLedgerStub & {
  workspaceId: string;
  userId: string;
  docId: string | null;
  actionType: ActionType;
  qualityTier: QualityTier;
  creditsFrom: Record<CreditBucket, number>;
};

export type WorkspaceBalanceSnapshot = {
  trialCreditsRemaining: number;
  subscriptionCreditsRemaining: number;
  purchasedCreditsRemaining: number;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  dailyCreditCap: number | null;
  monthlyCreditCap: number | null;
  perRunCreditCapBasic: number;
  perRunCreditCapStandard: number;
  perRunCreditCapAdvanced: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type CreditsUsageSums = {
  dailyReserved: number;
  monthlyReserved: number;
  monthlyOnDemandReserved: number;
};

/**
 * Outcome of one guarded ledger status transition.
 *
 * `moved` is the only reliable signal that this call is the one that changed the row: callers use
 * it to tell a real settle or refund from a replay that found the row already finished. A store
 * that cannot report the transition may return nothing, in which case callers treat the write as
 * having moved the row (the pre-guard behaviour).
 */
export type LedgerTransition = {
  /** True when this call moved the row into the requested status. */
  moved: boolean;
  /** Status the row held before the call, or null when the store cannot report it. */
  previousStatus: LedgerStatus | null;
};

export type CreditStore = {
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  getLedgerByIdempotencyKey(params: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<CreditLedgerStub | null>;

  createPendingLedger(params: {
    workspaceId: string;
    userId: string;
    docId: string | null;
    actionType: ActionType;
    qualityTier: QualityTier;
    idempotencyKey: string;
    requestId: string | null;
    creditsEstimated: number;
    creditsReserved: number;
    creditsFrom: Record<CreditBucket, number>;
    cycleKey: string;
    cycleStart: Date;
    cycleEnd: Date | null;
    day: string;
  }): Promise<{ id: string }>;

  getOrCreateBalance(params: {
    workspaceId: string;
    initIfMissing: () => Promise<WorkspaceBalanceSnapshot>;
  }): Promise<WorkspaceBalanceSnapshot>;

  saveBalance(params: { workspaceId: string; next: WorkspaceBalanceSnapshot }): Promise<void>;

  getUsageSums(params: {
    workspaceId: string;
    now: Date;
    cycleStart: Date;
  }): Promise<CreditsUsageSums>;

  getLedgerById(params: { ledgerId: string }): Promise<CreditLedgerFull | null>;

  setLedgerStatus(params: {
    ledgerId: string;
    status: LedgerStatus;
    /**
     * State guard: move the row only when its current status is one of these. The store must apply
     * it inside the update filter itself (never read-then-write), so two concurrent settles or a
     * settle racing the stale-reservation sweeper cannot both win.
     *
     * Omitted (or empty) means "no guard", which is the legacy, unsafe behaviour and is kept only
     * so that existing in-memory stores keep compiling.
     */
    expectedStatus?: readonly LedgerStatus[];
    creditsCharged?: number;
    telemetry?: Record<string, unknown> | null;
  }): Promise<LedgerTransition | void>;
};


