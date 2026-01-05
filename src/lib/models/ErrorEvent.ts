/**
 * ErrorEvent model.
 *
 * First-class structured error tracking stored in MongoDB (queryable + safe).
 * This is intentionally small and sanitized; never store secrets/PII here.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";

// NOTE: TTL index is fixed here (14 days). To change retention, use an index migration
// (see `scripts/recreate-error-ttl-index.ts`).
const TTL_SECONDS_14_DAYS = 14 * 24 * 60 * 60;

const errorEventSchema = new Schema(
  {
    createdAt: { type: Date, default: () => new Date(), required: true },
    env: { type: String, trim: true, default: "" },

    severity: { type: String, enum: ["error", "warn", "info"], required: true, index: true },
    category: { type: String, trim: true, default: "unknown", index: true },
    code: { type: String, trim: true, default: "UNHANDLED_EXCEPTION", index: true },

    message: { type: String, trim: true, required: true },
    stack: { type: String, trim: true, default: null },

    // Request-ish
    route: { type: String, trim: true, default: null, index: true },
    method: { type: String, trim: true, default: null },
    statusCode: { type: Number, default: null, min: 100, max: 599 },
    requestId: { type: String, trim: true, default: null },

    // Correlation ids (best-effort, optional)
    workspaceId: { type: Schema.Types.ObjectId, ref: "Org", default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null, index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },
    runId: { type: Schema.Types.ObjectId, ref: "AiRun", default: null, index: true },

    model: { type: String, trim: true, default: null },

    fingerprint: { type: String, trim: true, default: null, index: true },

    /**
     * Sanitized, size-bounded meta (never secrets/tokens/raw payloads).
     * This should be treated as untrusted input.
     */
    meta: { type: Schema.Types.Mixed, default: null },

    lastSeenAt: { type: Date, default: null },
  },
  { minimize: false },
);

// TTL retention: fixed 14 days.
errorEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS_14_DAYS });

// Query helpers
errorEventSchema.index({ createdAt: -1 });
errorEventSchema.index({ workspaceId: 1, createdAt: -1 });
errorEventSchema.index({ category: 1, createdAt: -1 });
errorEventSchema.index({ code: 1, createdAt: -1 });
errorEventSchema.index({ fingerprint: 1, createdAt: -1 });

export type ErrorEvent = Omit<
  InferSchemaType<typeof errorEventSchema>,
  "severity" | "category" | "meta" | "lastSeenAt"
> & {
  severity: ErrorSeverity;
  category: ErrorCategory;
  meta?: unknown;
  lastSeenAt?: Date | null;
};

export const ErrorEventModel: Model<ErrorEvent> =
  (mongoose.models.ErrorEvent as Model<ErrorEvent> | undefined) ??
  mongoose.model<ErrorEvent>("ErrorEvent", errorEventSchema);


