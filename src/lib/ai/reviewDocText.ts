/**
 * AI-powered document review.
 *
 * Generates a structured review (plus human-readable markdown) from PDF-extracted
 * text. The flow is resilient: if structured output fails, it falls back to
 * plain text generation and best-effort extraction.
 */
import { generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { Types } from "mongoose";
import { completeAiRun, failAiRun, startAiRun } from "@/lib/ai/aiRunRecorder";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PROMPTS_DIR = path.join(process.cwd(), "src/lib/prompts");
const REVIEW_SYSTEM_PROMPT_PATH = path.join(PROMPTS_DIR, "reviewDocText-system.md");
let cachedReviewSystemPrompt: string | null = null;
async function loadReviewSystemPrompt(): Promise<string> {
  if (cachedReviewSystemPrompt) return cachedReviewSystemPrompt;
  const text = (await readFile(REVIEW_SYSTEM_PROMPT_PATH, "utf8")).toString().trim();
  cachedReviewSystemPrompt = text;
  return text;
}
/** Trim and cap prompt text to keep token usage bounded (preserves head + tail). */
function trimForPrompt(input: string, max: number): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  // Keep cost bounded; preserve both beginning + end.
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.66));
  const tail = text.slice(-Math.floor(max * 0.34));
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}

function looksEarlyStageDeck(docText: string): boolean {
  const t = (docText ?? "").toLowerCase();
  if (!t) return false;
  // Heuristics: explicit stage labels or fundraising-for-prototype language.
  if (/\b(pre[-\s]?seed|seed)\b/i.test(docText)) return true;
  if (/\braising\s*\$\s*\d/i.test(docText)) return true;
  if (/\braising\b/i.test(docText) && (/\bprototype\b/i.test(docText) || /\bmvp\b/i.test(docText))) return true;
  return false;
}

function sanitizeInvestorFinancialLanguage(s: string): string {
  if (!s) return s;
  // Remove "crucial/critical/essential" framing around financial projections.
  return s
    .replace(
      /\b(crucial|critical|essential|required|must[-\s]?have)\b[^.]*\b(financial (projections?|model)|detailed financials?)\b[^.]*\./gi,
      "",
    )
    .replace(/\b(lacks?|missing)\b[^.]*\b(detailed )?financial (projections?|model)\b[^.]*\./gi, "")
    .replace(/\b(include|add|prepare|develop)\b[^.]*\b(financial (projections?|model)|detailed financials?)\b[^.]*\./gi, "");
}

function rewriteFinancialItemToUseOfFunds(item: { title: string; detail?: string | null }) {
  const title = item.title || "";
  const detail = item.detail ?? null;
  const text = `${title}\n${detail ?? ""}`.toLowerCase();
  const mentionsFinancial =
    text.includes("financial projection") ||
    text.includes("financial model") ||
    text.includes("detailed financial") ||
    text.includes("revenue projection") ||
    text.includes("forecast");
  if (!mentionsFinancial) return item;
  return {
    title: "Use of funds, runway, and milestone plan",
    detail:
      "For a seed/pre-seed prototype raise, a lightweight plan is enough: how the raise maps to runway, key build milestones, and what “success” unlocks for the next round.",
  };
}

function sanitizeIntelForEarlyStage(intel: any) {
  const next = { ...intel };
  if (typeof next.overallAssessment === "string") {
    next.overallAssessment = sanitizeInvestorFinancialLanguage(next.overallAssessment).trim() || next.overallAssessment;
  }
  if (typeof next.scoreRationale === "string") {
    next.scoreRationale = sanitizeInvestorFinancialLanguage(next.scoreRationale).trim() || next.scoreRationale;
  }

  const rewriteList = (xs: unknown) =>
    Array.isArray(xs) ? xs.map((x) => (x && typeof x === "object" ? rewriteFinancialItemToUseOfFunds(x as any) : x)) : xs;

  next.weaknessesAndRisks = rewriteList(next.weaknessesAndRisks);
  next.recommendations = rewriteList(next.recommendations);
  next.actionItems = rewriteList(next.actionItems);

  // If we removed a primary stated weakness, nudge the score slightly upward.
  const scoreWas = typeof next.effectivenessScore === "number" ? next.effectivenessScore : null;
  const rationale = (next.scoreRationale ?? "").toString().toLowerCase();
  if (scoreWas === 7 && rationale.includes("financial")) {
    next.effectivenessScore = 8;
  }
  return next;
}

function sanitizeReviewMarkdownForEarlyStage(markdown: string): string {
  if (!markdown) return markdown;
  let m = markdown;
  m = sanitizeInvestorFinancialLanguage(m);
  m = m.replace(/Lack of Financial Projections/gi, "Use of funds, runway, and milestone plan");
  m = m.replace(/Include Financial Projections/gi, "Clarify use of funds, runway, and milestones");
  m = m.replace(/Prepare Financial Model/gi, "Clarify use of funds and runway");
  return m.trim();
}
/** Extract a single "Label: value" line from markdown (case-insensitive). */
function extractLabeledLine(params: { markdown: string; label: string }): string | null {
  const { markdown, label } = params;
  const rx = new RegExp(`${label}\\s*:\\s*(.+)$`, "im");
  const m = rx.exec(markdown);
  const v = (m?.[1] ?? "").trim();
  if (!v) return null;
  if (/^(not found|n\/a|none|—|-|null)$/i.test(v)) return null;
  return v;
}
/** Extract a multi-line "Label:" block from markdown (best-effort). */
function extractLabeledBlock(params: { markdown: string; label: string }): string | null {
  const { markdown, label } = params;
  // Match:
  // Label:
  // <content...>
  // (until next blank line or next Title Case heading)
  const rx = new RegExp(
    `^\\s*${label}\\s*:\\s*(?:\\n+)?([\\s\\S]*?)(?=\\n\\s*\\n|^\\s*[A-Z][A-Za-z &/.-]{2,}\\s*$|\\Z)`,
    "im",
  );
  const m = rx.exec(markdown);
  const v = (m?.[1] ?? "").trim();
  if (!v) return null;
  if (/^(not found|n\/a|none|—|-|null)$/i.test(v)) return null;
  return v;
}
/** Extract a 1-10 relevance/effectiveness score from markdown. */
function extractScore(markdown: string): number | null {
  const m =
    /(?:Relevance\s*Score|Effectiveness\s*Score|Score)\s*:\s*([0-9]{1,2})\s*\/\s*10/i.exec(
      markdown,
    );
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 10) return null;
  return Math.floor(n);
}
/** Extract a section body under a given heading from markdown (best-effort). */
function extractSection(markdown: string, heading: string): string | null {
  // Match a section like:
  // Heading
  // <content...>
  const rx = new RegExp(
    `^\\s*${heading}\\s*$\\s*([\\s\\S]*?)(?=^\\s*[A-Z][A-Za-z &/.-]{2,}\\s*$|\\Z)`,
    "im",
  );
  const m = rx.exec(markdown);
  const v = (m?.[1] ?? "").trim();
  return v ? v : null;
}
/**
 * Build the model prompt for reviewing a doc, including optional prior review
 * context and requester instructions.
 */
export function buildReviewPrompt(input: {
  docText: string;
  priorReviewMarkdown?: string | null;
  priorReviewVersion?: number | null;
  instructions?: string | null;
  qualityTier?: "basic" | "standard" | "advanced";
}): string {
  const prior = (input.priorReviewMarkdown ?? "").trim();
  const instructions = (input.instructions ?? "").trim();
  const priorHeader =
    prior && Number.isFinite(input.priorReviewVersion)
      ? `\n\nTHIS IS THE LAST REVIEW (version ${input.priorReviewVersion}):\n\n${prior}\n`
      : prior
        ? `\n\nTHIS IS THE LAST REVIEW:\n\n${prior}\n`
        : "";

  const qualityTier = input.qualityTier ?? "standard";
  const max = qualityTier === "advanced" ? 60_000 : qualityTier === "basic" ? 25_000 : 45_000;
  const docText = trimForPrompt(input.docText, max);
  const instructionsHeader = instructions
    ? `\n\nREQUEST REVIEW INSTRUCTIONS:\n\n${instructions}\n`
    : "";
  return `${priorHeader}${instructionsHeader}\n\nDOCUMENT (PDF-extracted text):\n\n${docText}\n`;
}
/**
 * Generate a review for the provided document text.
 *
 * Returns null when AI is disabled (`OPENAI_API_KEY` not configured) or when
 * generation fails completely.
 */
export async function reviewDocText(input: {
  docText: string;
  priorReviewMarkdown?: string | null;
  priorReviewVersion?: number | null;
  instructions?: string | null;
  qualityTier?: "basic" | "standard" | "advanced";
  meta?: {
    userId?: string | null;
    projectId?: string | null;
    projectIds?: string[] | null;
    docId?: string | null;
    uploadId?: string | null;
    reviewId?: string | null;
    uploadVersion?: number | null;
  } | null;
}): Promise<{ markdown: string; prompt: string; model: string; intel?: unknown } | null> {
  // If key isn't configured, treat as "AI disabled" rather than failing uploads.
  if (!process.env.OPENAI_API_KEY) return null;

  const systemPrompt = await loadReviewSystemPrompt();

  const qualityTier = input.qualityTier ?? "standard";
  const prompt = buildReviewPrompt({ ...input, qualityTier });
  if (!prompt.trim()) return null;

  const modelName = "gpt-4o-mini";
  const temperature = 0.2;
  const maxRetries = qualityTier === "advanced" ? 2 : qualityTier === "standard" ? 1 : 0;

  const startedAt = Date.now();
  const meta = input.meta ?? null;
  const aiRunId = await startAiRun({
    kind: "reviewDocText",
    provider: "openai",
    model: modelName,
    temperature,
    maxRetries,
    systemPrompt,
    userPrompt: prompt,
    inputTextChars: prompt.length,
    meta,
  });

  const ItemSchema = z.object({
    title: z.string().min(1),
    detail: z.string().nullable().optional(),
  });
  const IntelSchema = z.object({
    company: z.object({
      name: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    }),
    contact: z.object({
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    }),
    overallAssessment: z.string().min(1),
    effectivenessScore: z.number().int().min(1).max(10),
    scoreRationale: z.string().min(1),
    strengths: z.array(ItemSchema).default([]),
    weaknessesAndRisks: z.array(ItemSchema).default([]),
    recommendations: z.array(ItemSchema).default([]),
    actionItems: z.array(ItemSchema).default([]),
    suggestedRewrites: z.string().nullable().optional(),
    reviewMarkdown: z.string().min(1),
  });

  try {
    const { object } = await generateObject({
      model: openai(modelName),
      system: systemPrompt,
      prompt,
      schema: IntelSchema,
      temperature,
      maxRetries,
    });
    const markdown = (object.reviewMarkdown ?? "").trim();
    if (!markdown) return null;
    const { reviewMarkdown: _rm, ...intelRaw } = object;

    // Some model outputs satisfy the schema but leave key fields null/empty.
    // Backfill from the markdown so the UI always has the basics.
    let intel = {
      ...intelRaw,
      overallAssessment:
        (typeof (intelRaw as any).overallAssessment === "string" && (intelRaw as any).overallAssessment.trim()
          ? (intelRaw as any).overallAssessment.trim()
          : (extractLabeledBlock({ markdown, label: "Overall Assessment" }) ??
              extractSection(markdown, "Overall Assessment"))) ?? null,
      effectivenessScore:
        (typeof (intelRaw as any).effectivenessScore === "number" && Number.isFinite((intelRaw as any).effectivenessScore)
          ? (intelRaw as any).effectivenessScore
          : extractScore(markdown)) ?? null,
      scoreRationale:
        (typeof (intelRaw as any).scoreRationale === "string" && (intelRaw as any).scoreRationale.trim()
          ? (intelRaw as any).scoreRationale.trim()
          : (extractLabeledBlock({ markdown, label: "Rationale" }) ??
              extractLabeledLine({ markdown, label: "Rationale" }) ??
              extractSection(markdown, "Score Rationale"))) ?? null,
      company: {
        ...(intelRaw as any).company,
        name:
          (typeof (intelRaw as any)?.company?.name === "string" && (intelRaw as any).company.name.trim()
            ? (intelRaw as any).company.name.trim()
            : extractLabeledLine({ markdown, label: "Company Name" })) ?? null,
        url:
          (typeof (intelRaw as any)?.company?.url === "string" && (intelRaw as any).company.url.trim()
            ? (intelRaw as any).company.url.trim()
            : extractLabeledLine({ markdown, label: "Company URL" })) ?? null,
      },
      contact: {
        ...(intelRaw as any).contact,
        name:
          (typeof (intelRaw as any)?.contact?.name === "string" && (intelRaw as any).contact.name.trim()
            ? (intelRaw as any).contact.name.trim()
            : extractLabeledLine({ markdown, label: "Contact Name" })) ?? null,
        email:
          (typeof (intelRaw as any)?.contact?.email === "string" && (intelRaw as any).contact.email.trim()
            ? (intelRaw as any).contact.email.trim()
            : extractLabeledLine({ markdown, label: "Contact Email" })) ?? null,
        url:
          (typeof (intelRaw as any)?.contact?.url === "string" && (intelRaw as any).contact.url.trim()
            ? (intelRaw as any).contact.url.trim()
            : extractLabeledLine({ markdown, label: "Contact URL" })) ?? null,
      },
    };

    // Guardrail: for clearly early-stage decks, enforce "no financial projections as a weakness".
    const earlyStage = looksEarlyStageDeck(input.docText);
    if (earlyStage) {
      intel = sanitizeIntelForEarlyStage(intel);
    }
    const finalMarkdown = earlyStage ? sanitizeReviewMarkdownForEarlyStage(markdown) : markdown;

    if (aiRunId) {
      await completeAiRun(aiRunId, {
        durationMs: Date.now() - startedAt,
        outputObject: object,
        outputText: finalMarkdown,
      });
    }

    return { markdown: finalMarkdown, prompt, model: modelName, intel };
  } catch {
    // Fallback: keep uploads working even if the model can't satisfy structured output.
    try {
      const { text } = await generateText({
        model: openai(modelName),
        system: systemPrompt,
        prompt,
        temperature,
        maxRetries,
      });
      const markdown = (text ?? "").trim();
      if (!markdown) return null;

      // Best-effort intel extraction from the markdown when structured generation fails.
      const companyName =
        extractLabeledLine({ markdown, label: "Company Name" }) ??
        extractLabeledLine({ markdown, label: "Company" });
      const companyUrl = extractLabeledLine({ markdown, label: "Company URL" });
      const contactName = extractLabeledLine({ markdown, label: "Contact Name" });
      const contactEmail = extractLabeledLine({ markdown, label: "Contact Email" });
      const contactUrl = extractLabeledLine({ markdown, label: "Contact URL" });

      const effectivenessScore = extractScore(markdown);
      const overallAssessment = extractSection(markdown, "Overall Assessment");
      const scoreRationale =
        extractLabeledBlock({ markdown, label: "Rationale" }) ??
        extractLabeledLine({ markdown, label: "Rationale" }) ??
        extractSection(markdown, "Score Rationale");

      const intel = {
        company: { name: companyName ?? null, url: companyUrl ?? null },
        contact: { name: contactName ?? null, email: contactEmail ?? null, url: contactUrl ?? null },
        overallAssessment: overallAssessment ?? null,
        effectivenessScore: effectivenessScore ?? null,
        scoreRationale: scoreRationale ?? null,
        strengths: [],
        weaknessesAndRisks: [],
        recommendations: [],
        actionItems: [],
        suggestedRewrites: null,
      };

      if (aiRunId) {
        await completeAiRun(aiRunId, { durationMs: Date.now() - startedAt, outputText: markdown });
      }

      return { markdown, prompt, model: modelName, intel };
    } catch (e) {
      if (aiRunId) {
        await failAiRun(aiRunId, { durationMs: Date.now() - startedAt, error: e });
      }
      return null;
    }
  }
}




