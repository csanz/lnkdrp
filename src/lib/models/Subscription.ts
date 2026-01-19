import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * Subscription model (per-org).
 *
 * This is the app's lightweight source of truth for whether an org is on a paid plan and,
 * if paid, which Stripe customer/subscription identifiers to use to create a billing portal session.
 */
const subscriptionSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true },

    /**
     * Stripe identifiers.
     *
     * Note: These are persisted so we can create a customer portal session on demand.
     */
    stripeCustomerId: { type: String, trim: true, default: null },
    stripeSubscriptionId: { type: String, trim: true, default: null },
    /**
     * Metered subscription item id for reporting ai_credits usage.
     *
     * Identified by matching `STRIPE_AI_CREDITS_PRICE_ID` against subscription items.
     */
    stripeSubscriptionItemId: { type: String, trim: true, default: null },

    /**
     * Stripe-like status values.
     *
     * We intentionally keep this as a string to avoid coupling too tightly to Stripe enums.
     */
    status: { type: String, trim: true, default: "free", index: true },

    /** Human-readable plan label shown in the UI. */
    planName: { type: String, trim: true, default: "Free" },

    /**
     * Stripe billing period boundaries (source of truth for the billing cycle).
     *
     * NOTE: Credits reset should be keyed off (stripeSubscriptionId + currentPeriodStart).
     */
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One subscription record per org (current state; keep history elsewhere if needed).
subscriptionSchema.index({ orgId: 1 }, { unique: true });

export type Subscription = InferSchemaType<typeof subscriptionSchema> & { orgId: Types.ObjectId };

export const SubscriptionModel: Model<Subscription> =
  (mongoose.models.Subscription as Model<Subscription> | undefined) ??
  mongoose.model<Subscription>("Subscription", subscriptionSchema);

// Dev safety: patch in new fields during hot reload (mongoose model caching).
const ExistingSubscriptionModel = mongoose.models.Subscription as Model<Subscription> | undefined;
if (ExistingSubscriptionModel && !ExistingSubscriptionModel.schema.path("stripeSubscriptionItemId")) {
  ExistingSubscriptionModel.schema.add({
    stripeSubscriptionItemId: { type: String, trim: true, default: null },
  } as any);
}
if (ExistingSubscriptionModel && !ExistingSubscriptionModel.schema.path("currentPeriodStart")) {
  ExistingSubscriptionModel.schema.add({
    currentPeriodStart: { type: Date, default: null },
  } as any);
}


