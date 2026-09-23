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
     * - review: Standard or Advanced default for new runs
     * - history (automatic AI compare): `null` = follow the plan (Basic on Free, Standard on Pro,
     *   see `getDefaultHistoryQualityTier` in `@/lib/credits/qualityDefaults`); a stored tier wins.
     */
    defaultReviewQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: "standard" },
    defaultHistoryQualityTier: { type: String, enum: ["basic", "standard", "advanced"], default: null },
    /**
     * The two AI runs nobody asks for, and so the only two worth a switch.
     *
     * Every other AI action starts with a click, and not clicking is already the off switch. These
     * two start on their own — a summary on every upload, a compare on every replacement — so they
     * are the ones that spend credits while someone is doing something else, and the ones a person
     * who uploads forty drafts a day wants to stop.
     *
     * Both default **on**: the summary is most of what makes a link worth sending, and a workspace
     * that never sees one has not really seen the product. Off is a deliberate act.
     *
     * `undefined` on a row written before this shipped, which `aiAutomation.ts` reads as on.
     */
    autoSummaryEnabled: { type: Boolean, default: true },
    autoCompareEnabled: { type: Boolean, default: true },
    /**
     * The third automatic run: a brief of every recipient visit, one credit each, written minutes
     * after the reader leaves (docs/prds/lnkdrp-visit-briefs.md). Pro only — on Free the flag is
     * stored but nothing reads it. Same default and same "absent is on" reading as the two above.
     */
    autoBriefEnabled: { type: Boolean, default: true },
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


