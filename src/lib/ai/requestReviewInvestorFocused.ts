/**
 * Request-review agent (investor focused): Guide vs Deck relevancy.
 *
 * This agent is used for request repos (inbound upload repositories) where the owner
 * attaches an optional "Guide" document (thesis/RFP/JD) to steer alignment scoring.
 *
 * Prompts are stored on disk under:
 * - `src/lib/ai/prompts/requestReview/investor_focused/system.md`
 * - `src/lib/ai/prompts/requestReview/investor_focused/user.md`
 *
 * Output schema matches `tests/agent/review/promps/investor_focused/agent_user.md`
 * (with placeholders renamed to {{Guide}} and {{Deck}} in the app prompt template).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { completeAiRun, failAiRun, startAiRun, type AiRunMeta } from "@/lib/ai/aiRunRecorder";

/** Output schema for the investor-focused request review agent. */
export const RequestReviewInvestorFocusedSchema = z
  .object({
    stage_match: z.boolean(),
    notes: z.string(),
    relevancy: z.enum(["low", "medium", "high"]),
    relevancy_reason: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    key_open_questions: z.array(z.string()),
    summary_markdown: z.string(),
    founder_note: z.string(),
  })
  .strict();

export type RequestReviewInvestorFocusedOutput = z.infer<typeof RequestReviewInvestorFocusedSchema>;

const PROMPTS_DIR = path.join(process.cwd(), "src/lib/ai/prompts/requestReview/investor_focused");
const SYSTEM_PATH = path.join(PROMPTS_DIR, "system.md");
const USER_PATH = path.join(PROMPTS_DIR, "user.md");

let cachedSystem: string | null = null;
let cachedUser: string | null = null;

async function loadPrompts(): Promise<{ system: string; userTemplate: string }> {
  const [system, userTemplate] = await Promise.all([
    cachedSystem ? Promise.resolve(cachedSystem) : readFile(SYSTEM_PATH, "utf8").then((s) => s.toString().trim()),
    cachedUser ? Promise.resolve(cachedUser) : readFile(USER_PATH, "utf8").then((s) => s.toString().trim()),
  ]);
  cachedSystem = system;
  cachedUser = userTemplate;
  return { system, userTemplate };
}

/** Trim and cap prompt text to keep token usage bounded (preserves head + tail). */
function trimForPrompt(input: string, max: number): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.66));
  const tail = text.slice(-Math.floor(max * 0.34));
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}

function normalizeStageHint(stageRaw: string | null | undefined): string | null {
  const s = (stageRaw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "pre-seed" || s === "preseed" || s === "seed") return "Pre-seed / Seed";
  if (s === "series a" || s === "series_a" || s === "a") return "Series A";
  if (s === "series b" || s === "series_b" || s === "b" || s.includes("b+")) return "Series B+";
  return stageRaw?.trim() || null;
}

function inferInvestorStageFocus(guideText: string): string {
  const t = (guideText ?? "").toLowerCase();
  const hasPreSeed = /\bpre[-\s]?seed\b/.test(t);
  const hasSeed = /\bseed\b/.test(t);
  const hasSeriesA = /\bseries\s*a\b/.test(t) || /\bseries_a\b/.test(t);
  const hasSeriesB = /\bseries\s*b\b/.test(t) || /\bseries_b\b/.test(t) || /\bseries\s*b\+\b/.test(t);

  const focus: string[] = [];
  const add = (s: string) => {
    if (!focus.includes(s)) focus.push(s);
  };
  if (hasPreSeed) add("Pre-seed");
  if (hasSeed) add("Seed");
  if (hasSeriesA) add("Series A");
  if (hasSeriesB) add("Series B+");
  if (hasSeed && hasSeriesB && !hasSeriesA) add("Series A");
  if (hasPreSeed && (hasSeriesA || hasSeriesB) && !hasSeed) add("Seed");
  if (hasPreSeed && hasSeriesB && !hasSeriesA) add("Series A");

  return focus.length ? focus.join(" / ") : "Unknown";
}

function inferCompanyStage(deckText: string, stageHint: string | null): string {
  const t = (deckText ?? "").toLowerCase();
  if (/\bpre[-\s]?seed\b/.test(t)) return "Pre-seed";
  if (/\bseed\b/.test(t)) return "Seed";
  if (/\bseries\s*a\b/.test(t)) return "Series A";
  if (/\bseries\s*b\+?\b/.test(t) || /\bseries\s*b\b/.test(t)) return "Series B+";
  return stageHint ?? "Unknown";
}

function fillUserTemplate(input: { template: string; guide: string; deck: string; stageHint: string | null }): string {
  const t = (input.template ?? "").toString();
  let out = t.replaceAll("{{Guide}}", input.guide ?? "").replaceAll("{{Deck}}", input.deck ?? "");
  if (input.stageHint) {
    out = out.replace(/Pre-seed\s*\/\s*Seed\s*\/\s*Series\s*A\s*\/\s*Series\s*B\+/i, input.stageHint);
  }
  return out.trim();
}

function extractJsonObject(rawText: string): unknown {
  const t = (rawText ?? "").trim();
  if (!t) throw new Error("Model returned empty text");
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Could not locate JSON object in output (len=${t.length})`);
  }
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * Run the investor-focused request review agent.
 *
 * - **guideText**: extracted text of the uploaded "Guide" document (optional; can be empty).
 * - **deckText**: extracted text of the uploaded document being reviewed (required).
 */
export async function runRequestReviewInvestorFocused(input: {
  guideText?: string | null;
  deckText: string;
  stageHint?: string | null;
  requesterInstructions?: string | null;
  qualityTier?: "basic" | "standard" | "advanced";
  meta?: AiRunMeta | null;
}): Promise<{
  model: string;
  system: string;
  prompt: string;
  rawOutputText: string;
  output: RequestReviewInvestorFocusedOutput;
}> {
  const qualityTier = input.qualityTier ?? "standard";
  const max = qualityTier === "advanced" ? 60_000 : qualityTier === "basic" ? 25_000 : 45_000;
  const guideText = trimForPrompt((input.guideText ?? "").toString(), max);
  const deckText = trimForPrompt((input.deckText ?? "").toString(), max);
  if (!deckText) throw new Error("Missing deckText");

  const { system: systemBase, userTemplate } = await loadPrompts();

  const stageHint = normalizeStageHint(input.stageHint);
  const userFilled = fillUserTemplate({ template: userTemplate, guide: guideText, deck: deckText, stageHint });

  const investorStageFocus = inferInvestorStageFocus(guideText);
  const companyStage = inferCompanyStage(deckText, stageHint);
  const rubric = [
    "",
    "STAGE_MATCH RUBRIC (authoritative):",
    `- Investor stage focus (from Guide): ${investorStageFocus}`,
    `- Company stage (from Deck): ${companyStage}`,
    `Set "stage_match" to true IFF the company stage is included in the investor stage focus.`,
    `Do NOT use business model, sector, hardware/software fit, or guide alignment when setting "stage_match" (that's what "relevancy" is for).`,
    "",
  ].join("\n");

  const requesterInstructions = (input.requesterInstructions ?? "").toString().trim();
  const system =
    requesterInstructions
      ? `${systemBase}\n\nREQUESTER INSTRUCTIONS (optional):\n\n${requesterInstructions}\n`
      : systemBase;

  const prompt = `${userFilled}\n${rubric}`.trim();

  const modelName = "gpt-4o-mini";
  const temperature = 0;
  const maxRetries = qualityTier === "advanced" ? 2 : qualityTier === "standard" ? 1 : 0;

  const startedAt = Date.now();
  const aiRunId = await startAiRun({
    kind: "requestReviewInvestorFocused",
    provider: "openai",
    model: modelName,
    temperature,
    maxRetries,
    systemPrompt: system,
    userPrompt: prompt,
    inputTextChars: prompt.length,
    meta: input.meta ?? null,
  });

  try {
    const { text } = await generateText({
      model: openai(modelName),
      system,
      prompt,
      temperature,
      maxRetries,
    });
    const rawOutputText = (text ?? "").toString().trim();
    const parsed = extractJsonObject(rawOutputText);
    const output = RequestReviewInvestorFocusedSchema.parse(parsed);
    await completeAiRun(aiRunId, { durationMs: Date.now() - startedAt, outputText: rawOutputText, outputObject: output });
    return { model: modelName, system, prompt, rawOutputText, output };
  } catch (e) {
    await failAiRun(aiRunId, { durationMs: Date.now() - startedAt, outputText: null, error: e });
    throw e;
  }
}


