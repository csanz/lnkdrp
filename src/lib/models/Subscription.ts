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
     * Identified by matching `STRIPE_AI_CREDITS_PRICE_ID` (legacy alias: `STRIPE_USAGE_PRICE_ID`)
     * against subscription items — see `getAiCreditsPriceId()`.
     */
    stripeSubscriptionItemId: { type: String, trim: true, default: null },

    /**
     * Stripe-like status values.
     *
     * We intentionally keep this as a string to avoid coupling too tightly to Stripe enums.
     */
    status: { type: String, trim: true, default: "free", index: true },

    /**
     * `event.created` of the Stripe event that last wrote this row.
     *
     * Stripe does not guarantee delivery order, and this webhook deliberately answers 400 on a
     * processing error so Stripe retries with backoff. Without a stamp the handlers overwrite
     * status unconditionally, so a retried older event can land after a newer one: an `updated`
     * carrying `active` fails on a transient error, `deleted` arrives and downgrades the row, the
     * retry of the older `updated` then writes it back to active - and Stripe sends nothing further
     * for a subscription that no longer exists, so that workspace keeps Pro, and its exemption from
     * the Free daily credit brake, indefinitely and for nothing.
     */
    lastStripeEventAt: { type: Date, default: null },

    /** Human-readable plan label shown in the UI. */
    planName: { type: String, trim: true, default: "Free" },

    /**
     * What the Stripe subscription is for, derived from its items by the webhook:
     * - `pro`: carries the Pro licensed price (and usually the metered credits price beside it)
     * - `payg`: the metered credits price alone — a Free workspace that added a card so it can be
     *   billed for on-demand credits; it is `active` in Stripe without being Pro
     * `null` on rows written before the field existed; those were all Pro. Read it through
     * `src/lib/billing/subscriptionState.ts`, never by comparing `status` alone.
     */
    kind: { type: String, enum: ["pro", "payg"], default: null },
    /**
     * How the Pro price bills: `month` or `year` (the annual plan). Written by the webhook from the
     * licensed item's `recurring.interval`. `null` on rows from before annual existed, read as monthly.
     */
    interval: { type: String, enum: ["month", "year"], default: null },

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


