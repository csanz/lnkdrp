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
      enum: ["summary", "review", "history", "unknown"],
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

    // True-cost tracking (persisted when available; null in fallback schedule iteration).
    costUnitsActual: { type: Number, default: null, min: 0 },
    costUsdActual: { type: Number, default: null, min: 0 },

    // Idempotency / correlation (unique per workspace).
    requestId: { type: String, trim: true, default: null },
    idempotencyKey: { type: String, trim: true, required: true },

    stripeUsageReportedAt: { type: Date, default: null, index: true },

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
    contextWindowUsed: { type: Number, default: null, min: 0 },

    // Internal bookkeeping for enforcing on-demand caps (not customer-facing).
    creditsFromTrial: { type: Number, default: 0, min: 0 },
    creditsFromSubscription: { type: Number, default: 0, min: 0 },
    creditsFromPurchased: { type: Number, default: 0, min: 0 },
    creditsFromOnDemand: { type: Number, default: 0, min: 0 },

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
if (ExistingCreditLedgerModel && !ExistingCreditLedgerModel.schema.path("adminReason")) {
  ExistingCreditLedgerModel.schema.add({
    adminReason: { type: String, trim: true, default: null },
    adminActorEmail: { type: String, trim: true, default: null },
  } as any);
}


