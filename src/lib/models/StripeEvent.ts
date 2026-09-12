import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * StripeEvent (minimal idempotency ledger).
 *
 * Webhooks can be delivered multiple times. We store Stripe's `event.id` with a unique index
 * so processing becomes idempotent even across restarts/serverless invocations.
 *
 * Processing contract (see `/api/stripe/webhook`):
 * - the row is inserted **before** processing (unique on `eventId`)
 * - `processedAt` is set only after processing succeeds
 * - a retry for a row with `processedAt=null` is allowed to re-process (previous attempt failed)
 * - a retry for a row with `processedAt` set is acknowledged without re-processing
 *
 * Keep this tiny: it's not meant for analytics; just for replay protection.
 */
const stripeEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true, trim: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
    /** Set when the webhook handler finished processing this event successfully. */
    processedAt: { type: Date, default: null },
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

// Dev safety: patch in new fields during hot reload (mongoose model caching).
const ExistingStripeEventModel = mongoose.models.StripeEvent as Model<StripeEvent> | undefined;
if (ExistingStripeEventModel && !ExistingStripeEventModel.schema.path("processedAt")) {
  ExistingStripeEventModel.schema.add({ processedAt: { type: Date, default: null } } as any);
}


