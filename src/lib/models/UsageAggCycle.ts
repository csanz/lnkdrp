import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * UsageAggCycle model.
 *
 * Pre-aggregated, per-workspace billing-cycle usage totals derived from `CreditLedger`.
 * Keyed by `(workspaceId, cycleKey)` where `cycleKey` is a stable identifier for the cycle.
 *
 * This is used to make `/api/credits/snapshot` bounded and fast (no ledger scans).
 */
const usageAggCycleSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Org", index: true, required: true },
    /** Stable cycle key (stored on ledger rows at reservation time). */
    cycleKey: { type: String, trim: true, index: true, required: true },

    cycleStart: { type: Date, default: null, index: true },
    cycleEnd: { type: Date, default: null },

    // Credits totals (customer-facing)
    includedUsedCredits: { type: Number, default: 0, min: 0 },
    paidUsedCredits: { type: Number, default: 0, min: 0 },
    totalUsedCredits: { type: Number, default: 0, min: 0 },
    onDemandUsedCredits: { type: Number, default: 0, min: 0 },

    // Telemetry-derived cost (internal; may be null/0 when true cost is unavailable).
    costUsdActual: { type: Number, default: 0, min: 0 },

    // Counts
    runs: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

usageAggCycleSchema.index({ workspaceId: 1, cycleKey: 1 }, { unique: true });
usageAggCycleSchema.index({ workspaceId: 1, cycleStart: -1 });

export type UsageAggCycle = InferSchemaType<typeof usageAggCycleSchema> & {
  workspaceId: Types.ObjectId;
};

export const UsageAggCycleModel: Model<UsageAggCycle> =
  (mongoose.models.UsageAggCycle as Model<UsageAggCycle> | undefined) ??
  mongoose.model<UsageAggCycle>("UsageAggCycle", usageAggCycleSchema);


