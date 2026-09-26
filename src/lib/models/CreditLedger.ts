import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * CreditLedger model.
 *
 * A per-run, idempotent ledger of AI credit reservations and charges.
 *
 * Customer-facing APIs must never return internal telemetry fields (provider/model/tokens/cost).
 */
const creditLedgerSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Org", index: true, required: true },
    // For system events (e.g. cycle grants), this can be null.
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, default: null },

    actionType: {
      type: String,
      enum: ["summary", "review", "history", "brief", "unknown"],
      required: true,
      index: true,
    },
    qualityTier: {
      type: String,
      enum: ["basic", "standard", "advanced"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["pending", "charged", "refunded", "failed"],
      default: "pending",
      index: true,
    },

    /**
     * Ledger event type (not user-facing).
     *
     * - `ai_run`: normal per-run credits
     * - `cycle_grant_included`: billing cycle reset/grant (idempotent by `cycleKey`)
     * - `free_floor_grant`: historical only — the Free monthly floor top-up that ran until
     *   2026-09-15 (idempotencyKey `free:{orgId}:{YYYY-MM}`, `creditsEstimated` = credits added).
     *   Rows exist; nothing writes new ones.
     */
    eventType: { type: String, trim: true, default: "ai_run", index: true },

    /** Billing cycle key for cycle-grant events: `${stripeSubscriptionId}:${currentPeriodStart}` */
    cycleKey: { type: String, trim: true, default: null, index: true },
    /**
     * Snapshot of cycle boundaries at the time of reservation/charge (best-effort).
     * Used to support fast pre-aggregation and reconciliation.
     */
    cycleStart: { type: Date, default: null, index: true },
    cycleEnd: { type: Date, default: null },

    creditsEstimated: { type: Number, min: 0, default: 0 },
    creditsReserved: { type: Number, min: 0, default: 0 },
    creditsCharged: { type: Number, min: 0, default: 0 },

    /**
     * True cost tracking.
     *
     * `costUsdActual` is what this run cost us in US dollars, written at settle time by
     * `markLedgerCharged` from the token telemetry beside it and the dated price table in
     * `src/lib/ai/modelPricing.ts`. Before 2026-09-26 nothing wrote it and every row was null; rows
     * older than that are still null and must not be back-filled with a guess. It stays null for a
     * run whose model the price table does not know and for one whose provider reported no usage,
     * so null means "not established" and never "free" — see `costUsdForLedgerTelemetry`.
     *
     * `costUnitsActual` is still written by nothing.
     *
     * **Read this before touching `usageAggregation.ts` or `/api/billing/usage`.** Invoice dollars
     * come from credits times the flat rate, and they must keep doing so. That fallback is not
     * redundant belt-and-braces: removing it is what made the billing header read $0.00 for a cycle
     * Stripe had really metered. It was safe to remove back then only because this field was always
     * null, and it is not null any more, so the same code now fails the other way: reading it would
     * price an invoice line at our provider cost and would drag allowance-funded runs, which charge
     * the customer no overage at all, onto the on-demand table. This field is our cost, not the
     * customer's price. The two are different numbers and no customer-facing route may read it.
     */
    costUnitsActual: { type: Number, default: null, min: 0 },
    costUsdActual: { type: Number, default: null, min: 0 },

    // Idempotency / correlation (unique per workspace).
    requestId: { type: String, trim: true, default: null },
    idempotencyKey: { type: String, trim: true, required: true },

    stripeUsageReportedAt: { type: Date, default: null, index: true },
    /**
     * Claim-then-report markers for Stripe metered reporting (`/api/cron/stripe-credits-report`).
     *
     * - `reportBatchId`: deterministic batch key; also used as the Stripe meter event `identifier`
     * - `reportClaimedAt`: when the batch claimed this row; stale claims (>30 min) may be re-claimed
     */
    reportBatchId: { type: String, trim: true, default: null, index: true },
    reportClaimedAt: { type: Date, default: null },

    /**
     * Internal telemetry (admin-only later; never returned in customer APIs).
     * Keep optional and sparse; not all AI providers return all fields.
     */
    provider: { type: String, trim: true, default: null },
    modelRoute: { type: String, trim: true, default: null },
    promptTokens: { type: Number, default: null, min: 0 },
    completionTokens: { type: Number, default: null, min: 0 },
    totalTokens: { type: Number, default: null, min: 0 },
    latencyMs: { type: Number, default: null, min: 0 },
    retriesCount: { type: Number, default: null, min: 0 },
    /**
     * How many images the request carried, and over how many pages.
     *
     * Without these a token total cannot be attributed: images are the overwhelming majority of a
     * compare's input, and what one costs depends on how the provider tiles it. With the count
     * beside the total, one real run answers it.
     */
    imagesAttached: { type: Number, default: null, min: 0 },
    pagesAttached: { type: Number, default: null, min: 0 },
    /**
     * Prompt tokens the provider billed at its cached rate (a subset of `promptTokens`, not extra
     * to it). Priced separately because the cached rate is half the full one, so a run with a large
     * reused prefix costs materially less than its token total suggests.
     */
    cachedInputTokens: { type: Number, default: null, min: 0 },
    /**
     * How many provider calls this one charge spanned.
     *
     * One charge is not one call: a summary retries once on a bad parse, a review falls back from
     * structured output to plain text, and both bill for the attempt that failed. Anything above 1
     * is a run that cost more than its price implies, and this is the column that shows it.
     */
    modelCalls: { type: Number, default: null, min: 0 },

    // Internal bookkeeping for enforcing on-demand caps (not customer-facing).
    creditsFromTrial: { type: Number, default: 0, min: 0 },
    creditsFromSubscription: { type: Number, default: 0, min: 0 },
    creditsFromPurchased: { type: Number, default: 0, min: 0 },
    creditsFromOnDemand: { type: Number, default: 0, min: 0 },

    /**
     * Who triggered the run. `owner` rows are billed to the workspace; `recipient` rows are
     * uploads made through a request/replace link by someone outside the workspace and are
     * always recorded at 0 credits (the owner never pays for a stranger's upload); `agent` rows are
     * summaries written by the uploading agent itself, also 0 credits.
     */
    source: { type: String, enum: ["owner", "recipient", "agent"], default: "owner", index: true },

    /** Idempotency marker: set when usage aggregates have been applied for this ledger row. */
    usageAggAppliedAt: { type: Date, default: null, index: true },

    /**
     * Admin-only audit metadata (never returned to customers).
     * Used by `/api/admin/credits/*` endpoints.
     */
    adminReason: { type: String, trim: true, default: null },
    adminActorEmail: { type: String, trim: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

creditLedgerSchema.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true });
creditLedgerSchema.index({ workspaceId: 1, createdDate: -1 });
creditLedgerSchema.index({ workspaceId: 1, status: 1, stripeUsageReportedAt: 1, createdDate: -1 });
creditLedgerSchema.index({ workspaceId: 1, eventType: 1, status: 1, createdDate: -1 });
creditLedgerSchema.index({ workspaceId: 1, eventType: 1, status: 1, cycleKey: 1, createdDate: -1 });
creditLedgerSchema.index({ workspaceId: 1, eventType: 1, status: 1, cycleStart: 1, createdDate: -1 });
creditLedgerSchema.index({ status: 1, eventType: 1, stripeUsageReportedAt: 1, createdDate: -1 });
creditLedgerSchema.index(
  { workspaceId: 1, eventType: 1, cycleKey: 1 },
  { unique: true, partialFilterExpression: { eventType: "cycle_grant_included", cycleKey: { $type: "string" } } } as any,
);
creditLedgerSchema.index({ status: 1, eventType: 1, stripeUsageReportedAt: 1, creditsFromOnDemand: 1, createdDate: -1 });
// Claim-then-report scan for the Stripe metered reporting cron.
creditLedgerSchema.index({ status: 1, eventType: 1, stripeUsageReportedAt: 1, reportBatchId: 1, reportClaimedAt: 1 });
// Speed up on-demand usage aggregates on hot paths (e.g. `/api/billing/spend` fallback).
creditLedgerSchema.index(
  { workspaceId: 1, eventType: 1, status: 1, cycleKey: 1, creditsFromOnDemand: 1 },
  {
    partialFilterExpression: {
      eventType: "ai_run",
      status: "charged",
      cycleKey: { $type: "string" },
      creditsFromOnDemand: { $gt: 0 },
    },
  } as any,
);

export type CreditLedger = InferSchemaType<typeof creditLedgerSchema> & {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId | null;
  docId: Types.ObjectId | null;
};

export const CreditLedgerModel: Model<CreditLedger> =
  (mongoose.models.CreditLedger as Model<CreditLedger> | undefined) ??
  mongoose.model<CreditLedger>("CreditLedger", creditLedgerSchema);

// Dev safety: patch in new fields during hot reload.
const ExistingCreditLedgerModel = mongoose.models.CreditLedger as Model<CreditLedger> | undefined;
if (ExistingCreditLedgerModel && !ExistingCreditLedgerModel.schema.path("eventType")) {
  ExistingCreditLedgerModel.schema.add({
    eventType: { type: String, trim: true, default: "ai_run", index: true },
    cycleKey: { type: String, trim: true, default: null, index: true },
  } as any);
}
if (ExistingCreditLedgerModel && !ExistingCreditLedgerModel.schema.path("reportBatchId")) {
  ExistingCreditLedgerModel.schema.add({
    reportBatchId: { type: String, trim: true, default: null, index: true },
    reportClaimedAt: { type: Date, default: null },
  } as any);
}
if (ExistingCreditLedgerModel && !ExistingCreditLedgerModel.schema.path("cachedInputTokens")) {
  ExistingCreditLedgerModel.schema.add({
    cachedInputTokens: { type: Number, default: null, min: 0 },
    modelCalls: { type: Number, default: null, min: 0 },
  } as any);
}
if (ExistingCreditLedgerModel && !ExistingCreditLedgerModel.schema.path("adminReason")) {
  ExistingCreditLedgerModel.schema.add({
    adminReason: { type: String, trim: true, default: null },
    adminActorEmail: { type: String, trim: true, default: null },
  } as any);
}


