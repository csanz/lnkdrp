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
    creditsCharged?: number;
    telemetry?: Record<string, unknown> | null;
  }): Promise<void>;
};


