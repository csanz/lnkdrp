import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Singleton app config for billing-related display settings.
 *
 * This is intentionally small and stable: it lets the app avoid calling Stripe on hot paths
 * (e.g. dashboard plan card) for values that rarely change (e.g. the Pro price label).
 */
const billingConfigSchema = new Schema(
  {
    /** Singleton key (only one doc). */
    key: { type: String, trim: true, required: true, default: "global" },

    /** UI display label for the Pro subscription price (e.g. "$20/mo"). */
    proPriceLabel: { type: String, trim: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

billingConfigSchema.index({ key: 1 }, { unique: true });

export type BillingConfig = InferSchemaType<typeof billingConfigSchema>;

export const BillingConfigModel: Model<BillingConfig> =
  (mongoose.models.BillingConfig as Model<BillingConfig> | undefined) ??
  mongoose.model<BillingConfig>("BillingConfig", billingConfigSchema);


