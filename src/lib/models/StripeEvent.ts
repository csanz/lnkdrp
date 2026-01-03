import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * StripeEvent (minimal idempotency ledger).
 *
 * Webhooks can be delivered multiple times. We store Stripe's `event.id` with a unique index
 * so processing becomes idempotent even across restarts/serverless invocations.
 *
 * Keep this tiny: it's not meant for analytics; just for replay protection.
 */
const stripeEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true, trim: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    timestamps: false,
    minimize: false,
  },
);

export type StripeEvent = InferSchemaType<typeof stripeEventSchema>;

export const StripeEventModel: Model<StripeEvent> =
  (mongoose.models.StripeEvent as Model<StripeEvent> | undefined) ??
  mongoose.model<StripeEvent>("StripeEvent", stripeEventSchema);


