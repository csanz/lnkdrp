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
     * Free monthly floor marker: the UTC month (`YYYY-MM`) whose floor this workspace has already
     * been evaluated for (`grantFreeMonthlyFloor` in `@/lib/credits/grants`). Claimed with a
     * conditional update so the floor lands at most once per month. `null` = never evaluated.
     */
    freeFloorMonth: { type: String, trim: true, default: null },

    /**
     * AI quality defaults (workspace-level).
     * These are user-facing tiers, not vendor model names.
     *
     * - summary: always Basic (automatic; not configurable here)
     * - review: Standard or Advanced default for new runs
     * - history (automatic AI compare): `null` = follow the plan (Basic on Free, Standard on Pro,
     *   see `getDefaultHistoryQualityTier` in `@/lib/credits/qualityDefaults`); a stored tier wins.
     */
    defaultReviewQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: "standard" },
    defaultHistoryQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One balance record per workspace.
workspaceCreditBalanceSchema.index({ workspaceId: 1 }, { unique: true });
// Cron scan for workspaces that have not been evaluated for this month's Free floor.
workspaceCreditBalanceSchema.index({ freeFloorMonth: 1 });

export type WorkspaceCreditBalance = InferSchemaType<typeof workspaceCreditBalanceSchema> & {
  workspaceId: Types.ObjectId;
};

export const WorkspaceCreditBalanceModel: Model<WorkspaceCreditBalance> =
  (mongoose.models.WorkspaceCreditBalance as Model<WorkspaceCreditBalance> | undefined) ??
  mongoose.model<WorkspaceCreditBalance>("WorkspaceCreditBalance", workspaceCreditBalanceSchema);


