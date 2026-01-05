import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * WorkspaceCreditBalance model (per-workspace/org).
 *
 * Stores customer-facing credit balances and policy settings for the workspace.
 * Internal telemetry and per-run details live in `CreditLedger`.
 */
const workspaceCreditBalanceSchema = new Schema(
  {
    // Indexed via the unique compound below; avoid duplicate single-field index warnings.
    workspaceId: { type: Schema.Types.ObjectId, ref: "Org", required: true },

    // Credit balances (customer-facing)
    trialCreditsRemaining: { type: Number, default: 0, min: 0 },
    subscriptionCreditsRemaining: { type: Number, default: 0, min: 0 },
    purchasedCreditsRemaining: { type: Number, default: 0, min: 0 },

    // On-demand policy (workspace-wide)
    onDemandEnabled: { type: Boolean, default: false },
    onDemandMonthlyLimitCents: { type: Number, default: 0, min: 0 },

    // Caps (best-effort guardrails; enforced during reservation)
    dailyCreditCap: { type: Number, default: null, min: 0 },
    monthlyCreditCap: { type: Number, default: null, min: 0 },
    perRunCreditCapBasic: { type: Number, default: 20, min: 0 },
    perRunCreditCapStandard: { type: Number, default: 60, min: 0 },
    perRunCreditCapAdvanced: { type: Number, default: 150, min: 0 },

    // Subscription period tracking (for included credits)
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },

    /**
     * AI quality defaults (workspace-level).
     * These are user-facing tiers, not vendor model names.
     *
     * - summary: always Basic (automatic; not configurable here)
     * - review/history: Standard or Advanced default for new runs
     */
    defaultReviewQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: "standard" },
    defaultHistoryQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: "standard" },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One balance record per workspace.
workspaceCreditBalanceSchema.index({ workspaceId: 1 }, { unique: true });

export type WorkspaceCreditBalance = InferSchemaType<typeof workspaceCreditBalanceSchema> & {
  workspaceId: Types.ObjectId;
};

export const WorkspaceCreditBalanceModel: Model<WorkspaceCreditBalance> =
  (mongoose.models.WorkspaceCreditBalance as Model<WorkspaceCreditBalance> | undefined) ??
  mongoose.model<WorkspaceCreditBalance>("WorkspaceCreditBalance", workspaceCreditBalanceSchema);


