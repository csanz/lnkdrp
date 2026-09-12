/**
 * `ratelimits` collection
 *
 * Fixed-window counters used by `src/lib/http/rateLimit.ts`.
 *
 * - `key`: opaque bucket id (e.g. `unlock:<ip>:<shareId>`), unique
 * - `count`: hits observed in the current window
 * - `windowStart` / `expiresAt`: bounds of the current window
 *
 * Expired buckets are garbage-collected by a TTL index on `expiresAt`; the rate limiter also
 * resets expired buckets in place, so correctness never depends on TTL timing.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const rateLimitSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    windowStart: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "ratelimits", minimize: false, versionKey: false },
);

// TTL: MongoDB removes documents once `expiresAt` has passed.
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimit = InferSchemaType<typeof rateLimitSchema>;

export const RateLimitModel: Model<RateLimit> =
  (mongoose.models.RateLimit as Model<RateLimit> | undefined) ??
  mongoose.model<RateLimit>("RateLimit", rateLimitSchema);
