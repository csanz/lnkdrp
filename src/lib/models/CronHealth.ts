import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Cron job health/heartbeat snapshot.
 *
 * Cron endpoints should upsert a record per `jobKey` so the admin UI can show
 * when each background task last ran, how long it took, and whether it errored.
 */
const cronHealthSchema = new Schema(
  {
    /**
     * Stable identifier for the job (e.g. "doc-metrics").
     */
    jobKey: { type: String, trim: true, index: true, unique: true, required: true },

    /**
     * Best-effort last known status of the job.
     */
    status: { type: String, enum: ["ok", "running", "error"], default: "ok", index: true },

    // Timing
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null, index: true },
    lastDurationMs: { type: Number, default: null, min: 0 },

    // Latest run context (kept small; mostly for debugging)
    lastParams: { type: Schema.Types.Mixed, default: null },
    lastResult: { type: Schema.Types.Mixed, default: null },

    // Error info from the most recent errored run
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

export type CronHealth = InferSchemaType<typeof cronHealthSchema>;

export const CronHealthModel: Model<CronHealth> =
  (mongoose.models.CronHealth as Model<CronHealth> | undefined) ??
  mongoose.model<CronHealth>("CronHealth", cronHealthSchema);


