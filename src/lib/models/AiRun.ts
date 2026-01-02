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
      enum: ["reviewDocText", "analyzePdfText", "requestReviewInvestorFocused"],
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

export type AiRun = InferSchemaType<typeof aiRunSchema>;

export const AiRunModel: Model<AiRun> =
  (mongoose.models.AiRun as Model<AiRun> | undefined) ?? mongoose.model<AiRun>("AiRun", aiRunSchema);


