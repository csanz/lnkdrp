/**
 * Doc change diff agent.
 *
 * Used when a user uploads a replacement for an existing doc version. The agent
 * compares the previous extracted text vs the new extracted text and returns a
 * short summary + a list of notable changes.
 */
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { OPENAI_PROVIDER_OPTIONS } from "./openaiProviderOptions";
import { z } from "zod";
import { NO_CHANGE_SUMMARY, isNoChangeSummary } from "./docChangeSummary";
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

/**
 * What one compare actually consumed, and what it was given to consume.
 *
 * Reported through `onUsage` rather than on the return value on purpose: the return value is
 * persisted verbatim as `DocChange.diff`, and that subdocument is a strict schema. Anything extra
 * hung off it would be silently dropped on save, which is the kind of thing that reads as working.
 *
 * `imagesAttached` and `pagesAttached` are here because `inputTokens` alone cannot be attributed.
 * Images are the overwhelming majority of a compare's input, and how many tokens an image costs
 * depends on how the provider tiles it, which is not something we control or can read back. With
 * the count beside the total, one real run answers it.
 */
export type DocChangeDiffUsage = {
  /** Total tokens billed as input: system, prompt, page context and every attached image. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Individual images in the request (two per page when both versions rendered). */
  imagesAttached: number;
  /** Pages that contributed at least one image, capped by tier. */
  pagesAttached: number;
  qualityTier: "basic" | "standard" | "advanced";
  /** Which model read it - the compare picks by modality, not by tier (see `modelForCompare`). */
  model: string;
};

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

export { NO_CHANGE_SUMMARY, isNoChangeSummary } from "./docChangeSummary";

/** Whitespace-insensitive text for the "did anything change at all" check. */
export function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

/**
 * Turn the measured difference rectangles into a sentence the model can act on.
 *
 * A vision model asked to find what changed on a page will find *something*, and on a dark cover
 * carrying one small mark it found the wrong thing: a logo removed from the top-left came back
 * described as a substitution involving the drone's tail marking, halfway down the page. It was
 * not looking in the wrong way, it was looking everywhere.
 *
 * These rectangles come from a deterministic pixel comparison, so they are the one part of this
 * prompt that cannot be imagined. Stated in plain fractions of the page - which is also why the
 * model is never asked to *produce* coordinates, only to use them.
 */
function describeRegions(regions: unknown): string {
  if (!Array.isArray(regions) || !regions.length) return "";
  const pct = (v: unknown) => Math.round(Math.max(0, Math.min(1, typeof v === "number" ? v : 0)) * 100);
  const parts = regions.slice(0, 6).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return `${pct(o.width)}% by ${pct(o.height)}% of the page, ${pct(o.x)}% from the left and ${pct(o.y)}% from the top`;
  });
  return `CHANGED_REGIONS (measured, not guessed): ${parts.join("; ")}`;
}

function normalizePageText(input: string, max: number): string {
  return (input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Which model reads this compare, and why it depends on whether images are attached.
 *
 * Both OpenAI models charge images by 512px tile, but at wildly different rates. Measured against
 * the live API on 2026-09-22, one 1200x675 page render costs 36,835 input tokens on gpt-4o-mini and
 * 1,105 on gpt-4o - a ratio of exactly 33.33, while mini's input price is only 16.67x cheaper. The
 * same picture therefore costs about twice as much in dollars on the small model.
 *
 * Context is the part that forces the issue rather than merely arguing for it. An advanced compare
 * attaches ten pages, previous and new, so twenty images: 736,700 tokens on mini against a 128k
 * window. Not slower or pricier - impossible. That failure only appears when many pages changed,
 * which is exactly the replacement an owner most wants explained.
 *
 * So the split is by modality, not by tier: text-only compares stay on mini, where its discount is
 * real and there are no tiles to pay for. Anything carrying page images goes to gpt-4o, which is
 * both cheaper for those tiles and the better reader of them - and reading them is the whole point,
 * since a swapped logo or a moved chart bar exists nowhere in the extracted text.
 */
function modelForCompare(hasImages: boolean): string {
  return hasImages ? "gpt-4o" : "gpt-4o-mini";
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
    /** Where the two renders differ, as fractions of the page. See `describeRegions`. */
    changedRegions?: Array<{ x: number; y: number; width: number; height: number }> | null;
  }>;
  /**
   * Page counts for the two versions, when the caller knows them.
   *
   * A decisive signal the text cannot supply: if the page count moved, the version did not "read
   * the same as the previous one", whatever the extracted text says. See the short-circuit below.
   */
  previousPageCount?: number | null;
  newPageCount?: number | null;
  qualityTier?: "basic" | "standard" | "advanced";
  /**
   * Optional abort signal (e.g. `AbortSignal.timeout(90_000)`); the AI call rejects with an
   * AbortError/TimeoutError when it fires. Callers must refund any credit reservation on failure.
   */
  abortSignal?: AbortSignal;
  /**
   * Called once, after a model call, with what it cost. Not called on the paths that never reach
   * the model (an identical re-upload, a missing API key, empty text) - those cost nothing.
   */
  onUsage?: (usage: DocChangeDiffUsage) => void;
}): Promise<DocChangeDiff | null> {
  // A re-upload of the same file: the model was asked to compare two identical texts and duly
  // invented "reorganized sections" and "updated terminology" (owner, 2026-09-17). Answered here,
  // before the model and before the API-key check, unless a page's image changed (same words, new
  // artwork) - that is a real change the text cannot show.
  //
  // `imageChanged` must be the perceptual verdict from `@/lib/history/changedPages`, not a byte
  // comparison: every MCP upload is re-encoded by Ghostscript (`mcp/src/optimize.ts`) and every page
  // is re-rendered here, so the bytes of an unchanged page differ on every single run. Fed a byte
  // verdict, this short-circuit never fires and the whole deck comes back as "graphics changed".
  const pagesIn = Array.isArray(input.changedPages) ? input.changedPages : [];
  const prevNorm = normalizeForCompare(input.previousText);
  const nextNorm = normalizeForCompare(input.newText);

  /**
   * A page count that moved settles it on its own.
   *
   * A version that gained five pages did not read the same as the previous one, however the text
   * compares - and it did compare equal, because pages appended with no extractable text change
   * neither side of the concatenation. Real rows said "No changes: this version reads the same as
   * the previous one" beside "13 to 18 pages" in the same sentence.
   */
  const pageCount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  const prevPages = pageCount(input.previousPageCount);
  const nextPages = pageCount(input.newPageCount);
  const pageCountMoved = prevPages !== null && nextPages !== null && prevPages !== nextPages;

  /**
   * No text on either side and no image verdict either is not evidence of sameness.
   *
   * Two empty strings compare equal, so a document nothing could read - a scan with no text layer,
   * a failed extraction - satisfied the text half of this test for free. With `imageChanged` null
   * on every page (no fingerprints, or none usable), the escape hatch below could not fire either,
   * and the answer came back as a confident "nothing changed" derived from having looked at
   * nothing. Falling through to the model is the honest outcome: it either reads the images or the
   * empty-text guard returns null and the credits are refunded.
   */
  const noEvidence = !prevNorm && !nextNorm && !pagesIn.some((p) => typeof p.imageChanged === "boolean");

  // A re-upload of the same file: the model was asked to compare two identical texts and duly
  // invented "reorganized sections" and "updated terminology" (owner, 2026-09-17). Answered here,
  // before the model and before the API-key check, unless a page's image changed (same words, new
  // artwork) - that is a real change the text cannot show.
  //
  // `imageChanged` must be the perceptual verdict from `@/lib/history/changedPages`, not a byte
  // comparison: every MCP upload is re-encoded by Ghostscript (`mcp/src/optimize.ts`) and every page
  // is re-rendered here, so the bytes of an unchanged page differ on every single run. Fed a byte
  // verdict, this short-circuit never fires and the whole deck comes back as "graphics changed".
  if (
    !pageCountMoved &&
    !noEvidence &&
    prevNorm === nextNorm &&
    !pagesIn.some((p) => p.imageChanged === true)
  ) {
    return { summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] };
  }

  if (!process.env.OPENAI_API_KEY) return null;

  const qualityTier = input.qualityTier ?? "standard";
  const max = qualityTier === "advanced" ? 50_000 : qualityTier === "basic" ? 20_000 : 35_000;
  const previousText = trimForPrompt(input.previousText, max);
  const newText = trimForPrompt(input.newText, max);
  if (!previousText || !newText) return null;

  const changedPages = Array.isArray(input.changedPages) ? input.changedPages : [];

  /**
   * The per-page block is the one part of the prompt nothing bounded by tier.
   *
   * `trimForPrompt` caps each full text at 20k/35k/50k chars and looks like the tier's cost
   * control, but the page block underneath it could reach 12 pages x 2 sides x 6,000 chars =
   * 144,000 chars, roughly 36k tokens - on basic, over three times the tier's entire text budget,
   * and largely the same words already present in PREVIOUS_TEXT and NEW_TEXT.
   */
  const perPageChars = qualityTier === "advanced" ? 6_000 : qualityTier === "basic" ? 1_500 : 3_000;

  const changedPagesText = changedPages.length
    ? changedPages
        .slice(0, MAX_PAGES_THAT_CHANGED)
        .map((p) => {
          const pageNumber = Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : NaN;
          if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
          const prev = normalizePageText(p.previousText, perPageChars);
          const next = normalizePageText(p.newText, perPageChars);
          const imgHint =
            typeof p.imageChanged === "boolean"
              ? `IMAGE_CHANGED: ${p.imageChanged ? "yes" : "no"}`
              : "";
          return [
            `Page ${pageNumber}:`,
            `PREVIOUS: ${prev || "[empty]"}`,
            `NEW: ${next || "[empty]"}`,
            imgHint,
            describeRegions(p.changedRegions),
          ]
            .filter(Boolean)
            .join("\n");
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
  // Counted for `onUsage`: an input token total says nothing without knowing how many images it
  // was carrying, and the images are most of it.
  let imagesAttached = 0;
  let pagesAttached = 0;
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
          if (prevImg) {
            parts.push({ type: "image", image: prevImg });
            imagesAttached += 1;
          }
          if (nextImg) {
            parts.push({ type: "image", image: nextImg });
            imagesAttached += 1;
          }
          attachedPages += 1;
        }
        pagesAttached = attachedPages;
        if (attachedPages < changedPages.length) {
          parts.push({
            type: "text",
            text: `Note: attached images for ${attachedPages} page(s) (cap=${maxAttachedPages}); remaining pages are provided as text-only context.`,
          });
        }
        return [{ role: "user", content: parts }];
      })()
    : null;

  const modelId = modelForCompare(Boolean(messages));
  const { object, usage } = await generateObject({
    model: openai(modelId),
    providerOptions: OPENAI_PROVIDER_OPTIONS,
    system,
    ...(messages ? { messages } : { prompt }),
    schema: DocChangeDiffSchema,
    temperature: 0,
    maxRetries: qualityTier === "advanced" ? 2 : qualityTier === "standard" ? 1 : 0,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });

  // Reported before the result is shaped, so a compare whose output we reject still tells us what
  // it cost - that is exactly the run worth knowing about.
  if (input.onUsage) {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    try {
      input.onUsage({
        inputTokens: n(usage?.inputTokens),
        outputTokens: n(usage?.outputTokens),
        imagesAttached,
        pagesAttached,
        qualityTier,
        model: modelId,
      });
    } catch {
      // Telemetry must never fail a compare the customer already paid for.
    }
  }

  // Extra guardrail: ensure summary is always <= MAX_SUMMARY_CHARS.
  const summary = (object.summary ?? "").toString().trim().slice(0, MAX_SUMMARY_CHARS).trimEnd();
  const changes = Array.isArray(object.changes) ? object.changes : [];
  const pagesThatChanged = Array.isArray((object as any).pagesThatChanged) ? (object as any).pagesThatChanged : [];
  // The summary and the page list must never contradict each other: if the model echoed the
  // no-change record, it cannot also list changed pages (see `docChangeSummary`).
  if (isNoChangeSummary(summary)) return { summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] };
  return { summary, changes, pagesThatChanged };
}


