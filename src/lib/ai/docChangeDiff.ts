/**
 * Doc change diff agent.
 *
 * Used when a user uploads a replacement for an existing doc version. The agent
 * compares the previous extracted text vs the new extracted text and returns a
 * short summary + a list of notable changes.
 */
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PROMPTS_DIR = path.join(process.cwd(), "src/lib/prompts");
const SYSTEM_PROMPT_PATH = path.join(PROMPTS_DIR, "docChangeDiff-system.md");
const USER_PROMPT_PATH = path.join(PROMPTS_DIR, "docChangeDiff-user.md");

const MAX_SUMMARY_CHARS = 400;

/** Output schema for doc change diffs. */
export const DocChangeDiffSchema = z
  .object({
    summary: z.string().max(MAX_SUMMARY_CHARS),
    changes: z.array(
      z
        .object({
          type: z.string(),
          title: z.string(),
          detail: z.string().nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type DocChangeDiff = z.infer<typeof DocChangeDiffSchema>;

let cachedPrompts: { system: string; user: string } | null = null;
async function loadPrompts(): Promise<{ system: string; user: string }> {
  if (cachedPrompts) return cachedPrompts;
  const [system, user] = await Promise.all([
    readFile(SYSTEM_PROMPT_PATH, "utf8"),
    readFile(USER_PROMPT_PATH, "utf8"),
  ]);
  cachedPrompts = { system: system.toString().trim(), user: user.toString().trim() };
  return cachedPrompts;
}

/** Trim and cap prompt text to keep token usage bounded (preserves head + tail). */
function trimForPrompt(input: string, max: number): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.64));
  const tail = text.slice(-Math.floor(max * 0.36));
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}

function fillUserPrompt(template: string, params: { previousText: string; newText: string }): string {
  return (template ?? "")
    .replaceAll("{{PREVIOUS_TEXT}}", params.previousText)
    .replaceAll("{{NEW_TEXT}}", params.newText)
    .trim();
}

/**
 * Compare two versions of extracted doc text and return a structured summary.
 *
 * Returns null when AI is disabled (`OPENAI_API_KEY` not configured) or when
 * either input is empty.
 */
export async function runDocChangeDiff(input: {
  previousText: string;
  newText: string;
  qualityTier?: "basic" | "standard" | "advanced";
}): Promise<DocChangeDiff | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const qualityTier = input.qualityTier ?? "standard";
  const max = qualityTier === "advanced" ? 50_000 : qualityTier === "basic" ? 20_000 : 35_000;
  const previousText = trimForPrompt(input.previousText, max);
  const newText = trimForPrompt(input.newText, max);
  if (!previousText || !newText) return null;

  const prompts = await loadPrompts();
  const system = prompts.system.trim();
  const prompt = fillUserPrompt(prompts.user, { previousText, newText });
  if (!system || !prompt) return null;

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    system,
    prompt,
    schema: DocChangeDiffSchema,
    temperature: 0,
    maxRetries: qualityTier === "advanced" ? 2 : qualityTier === "standard" ? 1 : 0,
  });

  // Extra guardrail: ensure summary is always <= MAX_SUMMARY_CHARS.
  const summary = (object.summary ?? "").toString().trim().slice(0, MAX_SUMMARY_CHARS).trimEnd();
  const changes = Array.isArray(object.changes) ? object.changes : [];
  return { summary, changes };
}


