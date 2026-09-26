import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * AI run log record for debugging prompt + output behavior.
 *
 * Stores the exact system/user prompts and model parameters used for each invocation
 * of AI features (e.g. review agent, PDF analysis) so admin tooling can inspect
 * what was sent and what came back.
 */
const aiRunSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, default: null },
    projectIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
      index: true,
      default: [],
    },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, default: null },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true, default: null },
    reviewId: { type: Schema.Types.ObjectId, ref: "Review", index: true, default: null },

    kind: {
      type: String,
      enum: ["reviewDocText", "analyzePdfText", "requestReviewInvestorFocused", "visitBrief"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["started", "completed", "failed"],
      default: "started",
      index: true,
    },

    // Provider/model params
    provider: { type: String, trim: true, default: "openai" },
    model: { type: String, trim: true, default: null },
    temperature: { type: Number, default: null },
    maxRetries: { type: Number, default: null },
    maxTokens: { type: Number, default: null },

    // Prompt inputs (may include document text; kept bounded upstream).
    systemPrompt: { type: String, default: null },
    userPrompt: { type: String, default: null },
    inputTextChars: { type: Number, min: 0, default: null },

    // Outputs (raw; best-effort)
    outputText: { type: String, default: null },
    outputObject: { type: Schema.Types.Mixed, default: null },

    /**
     * What the run actually spent, summed over every provider call it made.
     *
     * The row above records what was *asked for* (`model` is the configured model, `maxRetries` the
     * ceiling); these record what happened. They are here and not only on the credit ledger because
     * not every run is a charge: a recipient's upload, an agent's own summary and a failed run all
     * cost real money and bill nobody, and this is the only place that fact is written down.
     *
     * `modelRoute` is the model or models that actually ran, which is not always `model`: the
     * summary and the compare both pick by modality, so a page-image run goes to the dearer model
     * whatever tier was paid for. `modelCalls` above 1 means an attempt failed and was paid for.
     * `costUsdActual` is null, never 0, when the model is not in `src/lib/ai/modelPricing.ts` or
     * the provider reported no usage.
     */
    modelRoute: { type: String, trim: true, default: null },
    promptTokens: { type: Number, min: 0, default: null },
    completionTokens: { type: Number, min: 0, default: null },
    totalTokens: { type: Number, min: 0, default: null },
    cachedInputTokens: { type: Number, min: 0, default: null },
    modelCalls: { type: Number, min: 0, default: null },
    costUsdActual: { type: Number, min: 0, default: null },

    // Debug/error info
    error: { type: Schema.Types.Mixed, default: null },
    durationMs: { type: Number, min: 0, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

aiRunSchema.index({ kind: 1, createdDate: -1 });
aiRunSchema.index({ projectId: 1, createdDate: -1 });

/**
 * Rows expire. They hold prompt text built from customers' documents, kept for debugging, and
 * before this they were kept forever. `AI_RUN_RETENTION_DAYS` overrides the 30-day default; the
 * same number is applied by `db/migration/20260925_0004_airuns_ttl.mjs`, which also updates an
 * index created with a different value.
 */
export const AI_RUN_RETENTION_DAYS = (() => {
  const raw = Number((process.env.AI_RUN_RETENTION_DAYS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
})();
aiRunSchema.index({ createdDate: 1 }, { expireAfterSeconds: AI_RUN_RETENTION_DAYS * 24 * 60 * 60, name: "createdDate_ttl" });

export type AiRun = InferSchemaType<typeof aiRunSchema>;

export const AiRunModel: Model<AiRun> =
  (mongoose.models.AiRun as Model<AiRun> | undefined) ?? mongoose.model<AiRun>("AiRun", aiRunSchema);

// Dev safety: patch the cost fields in during hot reload, so an already-registered model still
// persists them instead of silently dropping the update.
const ExistingAiRunModel = mongoose.models.AiRun as Model<AiRun> | undefined;
if (ExistingAiRunModel && !ExistingAiRunModel.schema.path("costUsdActual")) {
  ExistingAiRunModel.schema.add({
    modelRoute: { type: String, trim: true, default: null },
    promptTokens: { type: Number, min: 0, default: null },
    completionTokens: { type: Number, min: 0, default: null },
    totalTokens: { type: Number, min: 0, default: null },
    cachedInputTokens: { type: Number, min: 0, default: null },
    modelCalls: { type: Number, min: 0, default: null },
    costUsdActual: { type: Number, min: 0, default: null },
  } as any);
}


