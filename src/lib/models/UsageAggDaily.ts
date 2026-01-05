import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * UsageAggDaily model.
 *
 * Pre-aggregated, per-workspace daily usage totals (UTC day buckets) derived from `CreditLedger`.
 * Intended for fast dashboard charts and bounded-cycle reporting without scanning the full ledger.
 */
const usageAggDailySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Org", index: true, required: true },
    /** UTC day key: "YYYY-MM-DD" */
    day: { type: String, trim: true, index: true, required: true },

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

usageAggDailySchema.index({ workspaceId: 1, day: 1 }, { unique: true });
usageAggDailySchema.index({ workspaceId: 1, day: -1 });

export type UsageAggDaily = InferSchemaType<typeof usageAggDailySchema> & {
  workspaceId: Types.ObjectId;
};

export const UsageAggDailyModel: Model<UsageAggDaily> =
  (mongoose.models.UsageAggDaily as Model<UsageAggDaily> | undefined) ??
  mongoose.model<UsageAggDaily>("UsageAggDaily", usageAggDailySchema);


