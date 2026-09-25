import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { AiRunModel } from "@/lib/models/AiRun";

/**
 * Shared "AI run" recorder helpers.
 *
 * These helpers are best-effort and never throw: AI features should keep working
 * even if logging fails.
 */

export type AiRunKind = "reviewDocText" | "analyzePdfText" | "requestReviewInvestorFocused" | "visitBrief";

export type AiRunMeta = {
  userId?: string | null;
  projectId?: string | null;
  projectIds?: string[] | null;
  docId?: string | null;
  uploadId?: string | null;
  reviewId?: string | null;
};

/** Trim and cap stored prompt/output text to avoid oversized Mongo documents (preserves head + tail). */
/**
 * Longest prompt text kept on an `AiRun` row, in characters.
 *
 * The row exists for debugging (what was sent, what came back), not as an archive: the user
 * prompt carries the customer's document text, and 220k characters of it per run sat in the
 * database with no expiry. The head and tail are what a debugging read needs; the middle is the
 * document, which the upload already stores. Rows also expire (`AI_RUN_RETENTION_DAYS`, see
 * `src/lib/models/AiRun.ts`).
 */
export const AI_RUN_PROMPT_MAX_CHARS = 50_000;

function trimForStorage(input: string | null | undefined, max = AI_RUN_PROMPT_MAX_CHARS): string | null {
  const text = (input ?? "").toString().trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.66));
  const tail = text.slice(-Math.floor(max * 0.34));
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}

function toObjectId(id: string | null | undefined): Types.ObjectId | null {
  return id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function toObjectIdArray(ids: string[] | null | undefined): Types.ObjectId[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id) => typeof id === "string" && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
}

/**
 * Create an AiRun record and return its id (or null if logging fails).
 */
export async function startAiRun(args: {
  kind: AiRunKind;
  provider: string;
  model: string | null;
  temperature: number | null;
  maxRetries: number | null;
  maxTokens?: number | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  inputTextChars: number | null;
  meta?: AiRunMeta | null;
}): Promise<Types.ObjectId | null> {
  try {
    await connectMongo();
    const meta = args.meta ?? null;
    const systemPrompt = trimForStorage(args.systemPrompt);
    const userPrompt = trimForStorage(args.userPrompt);
    const created = await AiRunModel.create({
      kind: args.kind,
      status: "started",
      provider: args.provider,
      model: args.model,
      temperature: args.temperature,
      maxRetries: args.maxRetries,
      maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : null,
      systemPrompt,
      userPrompt,
      inputTextChars: args.inputTextChars,
      userId: toObjectId(meta?.userId),
      projectId: toObjectId(meta?.projectId),
      projectIds: toObjectIdArray(meta?.projectIds),
      docId: toObjectId(meta?.docId),
      uploadId: toObjectId(meta?.uploadId),
      reviewId: toObjectId(meta?.reviewId),
    });
    return created?._id ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark an AiRun as completed (best-effort).
 */
export async function completeAiRun(
  aiRunId: Types.ObjectId | null,
  args: { durationMs: number; outputText?: string | null; outputObject?: unknown },
): Promise<void> {
  if (!aiRunId) return;
  try {
    const update: Record<string, unknown> = {
      status: "completed",
      durationMs: args.durationMs,
    };
    if (typeof args.outputText === "string") update.outputText = trimForStorage(args.outputText, 220_000);
    if (typeof args.outputObject !== "undefined") update.outputObject = args.outputObject;
    await AiRunModel.findByIdAndUpdate(aiRunId, update);
  } catch {
    // ignore
  }
}

/**
 * Mark an AiRun as failed (best-effort).
 */
export async function failAiRun(
  aiRunId: Types.ObjectId | null,
  args: { durationMs: number; outputText?: string | null; error: unknown },
): Promise<void> {
  if (!aiRunId) return;
  try {
    const update: Record<string, unknown> = {
      status: "failed",
      durationMs: args.durationMs,
      error:
        args.error instanceof Error
          ? { message: args.error.message, name: args.error.name, stack: args.error.stack }
          : String(args.error),
    };
    if (typeof args.outputText === "string") update.outputText = trimForStorage(args.outputText, 220_000);
    await AiRunModel.findByIdAndUpdate(aiRunId, update);
  } catch {
    // ignore
  }
}


