import mongoose, { Schema, type InferSchemaType, type Model, Types } from "mongoose";

/**
 * CreditPurchase — one prepaid credit pack bought through Stripe Checkout (`src/lib/credits/packs.ts`).
 *
 * The credits themselves land in `WorkspaceCreditBalance.purchasedCreditsRemaining`; this row is
 * what makes the grant idempotent (unique Checkout session id) and what the daily expiry job reads
 * to take unspent credits back 12 months later (`expiredAt` set once that happened).
 */
const creditPurchaseSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    packId: { type: String, required: true, trim: true },
    credits: { type: Number, required: true, min: 1 },
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true },
    stripeCheckoutSessionId: { type: String, required: true, trim: true },
    stripePaymentIntentId: { type: String, default: null, trim: true },
    purchasedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    /** When the expiry job took this purchase's unspent credits back; null while live. */
    expiredAt: { type: Date, default: null },
    /** Credits removed at expiry (0 when all of them had been used). */
    creditsExpired: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" }, minimize: false },
);

creditPurchaseSchema.index({ stripeCheckoutSessionId: 1 }, { unique: true });
creditPurchaseSchema.index({ orgId: 1, expiredAt: 1, purchasedAt: 1 });
creditPurchaseSchema.index({ expiredAt: 1, expiresAt: 1 });

export type CreditPurchase = InferSchemaType<typeof creditPurchaseSchema> & { _id: Types.ObjectId };

export const CreditPurchaseModel: Model<CreditPurchase> =
  (mongoose.models.CreditPurchase as Model<CreditPurchase> | undefined) ??
  mongoose.model<CreditPurchase>("CreditPurchase", creditPurchaseSchema);
