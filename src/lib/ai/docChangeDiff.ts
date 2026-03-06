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
const MAX_PAGE_SUMMARY_CHARS = 220;
const MAX_PAGES_THAT_CHANGED = 30;

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
    pagesThatChanged: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1),
            summary: z.string().max(MAX_PAGE_SUMMARY_CHARS),
          })
          .strict(),
      )
      .max(MAX_PAGES_THAT_CHANGED),
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

function fillUserPrompt(
  template: string,
  params: { previousText: string; newText: string; changedPages: string },
): string {
  return (template ?? "")
    .replaceAll("{{PREVIOUS_TEXT}}", params.previousText)
    .replaceAll("{{NEW_TEXT}}", params.newText)
    .replaceAll("{{CHANGED_PAGES}}", params.changedPages)
    .trim();
}

function normalizePageText(input: string): string {
  return (input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
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
  /**
   * Optional page-level context for changed pages.
   * When provided, the model should use it to populate `pagesThatChanged`.
   */
  changedPages?: Array<{
    pageNumber: number;
    previousText: string;
    newText: string;
    /** Optional slide thumbnails for vision-capable diffs. */
    previousImageUrl?: string | null;
    newImageUrl?: string | null;
    imageChanged?: boolean | null;
  }>;
  qualityTier?: "basic" | "standard" | "advanced";
}): Promise<DocChangeDiff | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const qualityTier = input.qualityTier ?? "standard";
  const max = qualityTier === "advanced" ? 50_000 : qualityTier === "basic" ? 20_000 : 35_000;
  const previousText = trimForPrompt(input.previousText, max);
  const newText = trimForPrompt(input.newText, max);
  if (!previousText || !newText) return null;

  const changedPages = Array.isArray(input.changedPages) ? input.changedPages : [];
  const changedPagesText = changedPages.length
    ? changedPages
        .slice(0, MAX_PAGES_THAT_CHANGED)
        .map((p) => {
          const pageNumber = Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : NaN;
          if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
          const prev = normalizePageText(p.previousText);
          const next = normalizePageText(p.newText);
          const imgHint =
            typeof p.imageChanged === "boolean"
              ? `IMAGE_CHANGED: ${p.imageChanged ? "yes" : "no"}`
              : "";
          return [
            `Page ${pageNumber}:`,
            `PREVIOUS: ${prev || "[empty]"}`,
            `NEW: ${next || "[empty]"}`,
            imgHint,
          ].join("\n");
        })
        .filter(Boolean)
        .join("\n\n---\n\n")
    : "No page-level context available.";

  const prompts = await loadPrompts();
  const system = prompts.system.trim();
  const prompt = fillUserPrompt(prompts.user, { previousText, newText, changedPages: changedPagesText });
  if (!system || !prompt) return null;

  const hasAnyImages = changedPages.some((p) => {
    const a = typeof p?.previousImageUrl === "string" && p.previousImageUrl.trim();
    const b = typeof p?.newImageUrl === "string" && p.newImageUrl.trim();
    return Boolean(a || b);
  });

  const maxAttachedPages = qualityTier === "advanced" ? 10 : qualityTier === "basic" ? 4 : 7;
  const messages: any[] | null = hasAnyImages
    ? (() => {
        const parts: any[] = [{ type: "text", text: prompt }];
        let attachedPages = 0;
        for (const p of changedPages.slice(0, MAX_PAGES_THAT_CHANGED)) {
          if (attachedPages >= maxAttachedPages) break;
          const pageNumber = Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : NaN;
          if (!Number.isFinite(pageNumber) || pageNumber < 1) continue;
          const prevImg = typeof p.previousImageUrl === "string" && p.previousImageUrl.trim() ? p.previousImageUrl.trim() : "";
          const nextImg = typeof p.newImageUrl === "string" && p.newImageUrl.trim() ? p.newImageUrl.trim() : "";
          if (!prevImg && !nextImg) continue;
          parts.push({ type: "text", text: `Page ${pageNumber} images (previous then new):` });
          if (prevImg) parts.push({ type: "image", image: prevImg });
          if (nextImg) parts.push({ type: "image", image: nextImg });
          attachedPages += 1;
        }
        if (attachedPages < changedPages.length) {
          parts.push({
            type: "text",
            text: `Note: attached images for ${attachedPages} page(s) (cap=${maxAttachedPages}); remaining pages are provided as text-only context.`,
          });
        }
        return [{ role: "user", content: parts }];
      })()
    : null;

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    system,
    ...(messages ? { messages } : { prompt }),
    schema: DocChangeDiffSchema,
    temperature: 0,
    maxRetries: qualityTier === "advanced" ? 2 : qualityTier === "standard" ? 1 : 0,
  });

  // Extra guardrail: ensure summary is always <= MAX_SUMMARY_CHARS.
  const summary = (object.summary ?? "").toString().trim().slice(0, MAX_SUMMARY_CHARS).trimEnd();
  const changes = Array.isArray(object.changes) ? object.changes : [];
  const pagesThatChanged = Array.isArray((object as any).pagesThatChanged) ? (object as any).pagesThatChanged : [];
  return { summary, changes, pagesThatChanged };
}


