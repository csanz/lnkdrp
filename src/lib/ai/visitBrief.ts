/**
 * The visit brief: the model's account of one recipient's reading session.
 *
 * Input is a structured record built by `src/lib/visits/visitBriefs.ts` from `ShareVisit` rows —
 * pages, seconds, order, returns — plus a per-page outline of the document so the model can say
 * "the pricing page" rather than "page 7". Nothing the reader wrote goes in; the only free text is
 * the names people typed (viewer, link label, audience), which the system prompt says to treat as
 * names and nothing else, and which are capped and flattened here before they reach the prompt.
 *
 * One model, one tier: gpt-4o at temperature 0 with a fixed output schema (see `VISIT_BRIEF_MODEL`).
 * A few thousand tokens in and a few hundred out, which is why a brief is one credit and has no
 * quality level to choose.
 *
 * Recorded through `aiRunRecorder` like every other run, with `kind: "visitBrief"`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { OPENAI_PROVIDER_OPTIONS } from "./openaiProviderOptions";
import { completeAiRun, failAiRun, startAiRun } from "./aiRunRecorder";

/**
 * `gpt-4o` by default. The brief is asked to read a few pages of text and say what on them held
 * the reader; mini named the heading and stopped, and led with the page opened most often rather
 * than the one held longest, against instructions. The run is ~3k tokens in and ~250 out — about a
 * cent on gpt-4o — against the credit the workspace pays for it. `VISIT_BRIEF_MODEL` overrides.
 */
export const VISIT_BRIEF_MODEL = (process.env.VISIT_BRIEF_MODEL ?? "").trim() || "gpt-4o";
const MAX_OUTPUT_TOKENS = 700;

const PROMPTS_DIR = path.join(process.cwd(), "src/lib/prompts");
const SYSTEM_PROMPT_PATH = path.join(PROMPTS_DIR, "visitBrief-system.md");
const USER_PROMPT_PATH = path.join(PROMPTS_DIR, "visitBrief-user.md");

/** Longest a typed-in name or label is allowed to be once it reaches the prompt. */
const NAME_MAX = 120;

// ---------------------------------------------------------------------------------------------
// The record the model reads
// ---------------------------------------------------------------------------------------------

export type VisitBriefPage = {
  page: number;
  seconds: number;
  /** How many separate times the reader opened this page during the sitting. */
  opened: number;
};

export type VisitBriefDocument = {
  title: string;
  pageCount: number | null;
  /** Every page seen, in first-seen order. */
  pages: VisitBriefPage[];
  /** The sequence of page turns, e.g. [1, 2, 3, 7, 3]. Capped. */
  readingOrder: number[];
  pagesNeverOpened: number[];
  downloads: number;
  totalSeconds: number;
};

/**
 * One page as the model sees it. `text` is present only for the pages that held the reader or
 * that they came back to — the ones the brief is asked to interpret — so the prompt carries a few
 * whole pages rather than a whole document.
 */
export type VisitBriefOutlineEntry = { page: number; heading: string | null; excerpt: string | null; text?: string | null };

export type VisitBriefRecord = {
  link: { label: string | null; audience: string | null; isDefault: boolean; kind: "document" | "project" };
  viewer: { name: string | null; email: string | null; source: "account" | "volunteered" | "unknown" };
  visit: {
    startedAt: string;
    endedAt: string;
    totalSeconds: number;
    /** Absent on a first visit: given `1`, the model narrates "their first visit", which nobody asked. */
    visitNumber?: number;
    documents: VisitBriefDocument[];
  };
  /** Keyed by document title, as in `visit.documents`. */
  outline: Record<string, VisitBriefOutlineEntry[]> | null;
  previous: {
    priorVisits: number;
    lastVisitStartedAt: string | null;
    lastVisitTotalSeconds: number | null;
    lastVisitTopPages: number[];
  } | null;
};

// ---------------------------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------------------------

/**
 * Loose on the way in, strict on the way out — the same reason `analyzePdfText` keeps two schemas.
 * `generateObject` fails hard when the model omits a key or returns null; a brief with an empty
 * `followUp` is a brief, not a failure.
 */
/**
 * A list item may come back as a string or as an object (`{ topic, evidence, meaning }`) — gpt-4o
 * did exactly that once the `interests` instruction described a shape, and the strict schema then
 * refused the whole brief. Either form is accepted and flattened to one line.
 */
const ListItem = z.union([z.string(), z.record(z.string(), z.unknown())]);

const VisitBriefGenerationSchema = z.object({
  headline: z.string(),
  body: z.string(),
  interests: z.array(ListItem).nullable().optional(),
  highlights: z.array(ListItem).nullable().optional(),
  followUp: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
});

export type VisitBriefOutput = {
  headline: string;
  body: string;
  /** What caught their attention: the topics on the pages they held or returned to, ≤ 3. */
  interests: string[];
  highlights: string[];
  followUp: string | null;
};

export type VisitBriefTelemetry = {
  provider: "openai";
  modelRoute: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  retriesCount: number;
};

export type VisitBriefResult = {
  output: VisitBriefOutput;
  telemetry: VisitBriefTelemetry;
  aiRunId: string | null;
};

/** The template runs "spent 2 min on <topic>, came back to it twice, then downloaded the deck": room for that. */
const HEADLINE_MAX_WORDS = 18;
const HEADLINE_MAX_CHARS = 150;
const BODY_MAX_CHARS = 700;
const HIGHLIGHT_MAX = 4;
const HIGHLIGHT_MAX_CHARS = 140;
const INTEREST_MAX = 3;
const INTEREST_MAX_CHARS = 200;
const FOLLOW_UP_MAX_CHARS = 200;

function oneLine(v: unknown, max: number): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    // An object where a line was asked for: its string values, in order, as one line.
    v = Object.values(v as Record<string, unknown>)
      .filter((x) => typeof x === "string" && x.trim())
      .join(" — ");
  }
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Trim to the budget the subject line can carry — at a clause boundary, never mid-thought.
 *
 * The first cut at this took the first twelve words and shipped a subject ending in ", then". A
 * headline over budget now loses whole trailing clauses (the parts after a comma) until it fits,
 * and a dangling "then", "and" or "with" at the end goes with them.
 */
export function trimHeadline(v: unknown): string {
  let text = oneLine(v, 400);
  const fits = (s: string) => s.split(" ").filter(Boolean).length <= HEADLINE_MAX_WORDS && s.length <= HEADLINE_MAX_CHARS;
  while (!fits(text) && text.includes(",")) text = text.slice(0, text.lastIndexOf(",")).trim();
  if (!fits(text)) text = text.split(" ").filter(Boolean).slice(0, HEADLINE_MAX_WORDS).join(" ").slice(0, HEADLINE_MAX_CHARS);
  return text.replace(/[,;:\s]+(then|and|with|but|or|to|on|of|the|a|an)?$/i, "").trim();
}

export function normalizeVisitBriefOutput(raw: z.infer<typeof VisitBriefGenerationSchema>): VisitBriefOutput {
  const headline = trimHeadline(raw.headline);
  const body = typeof raw.body === "string" ? raw.body.replace(/[ \t]+/g, " ").trim().slice(0, BODY_MAX_CHARS) : "";
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : [])
    .map((h) => oneLine(h, HIGHLIGHT_MAX_CHARS))
    .filter(Boolean)
    .slice(0, HIGHLIGHT_MAX);
  // A cover, title, agenda or contents page is never what caught anyone: readers park on it. The
  // prompt says so and the model lists it anyway, so it is dropped here.
  const parked = /^(the\s+)?(cover|title|contents|table of contents|agenda|intro(duction)?|thank you|closing)\b/i;
  const interests = (Array.isArray(raw.interests) ? raw.interests : [])
    .map((h) => oneLine(h, INTEREST_MAX_CHARS))
    .filter((h) => h && !parked.test(h))
    .slice(0, INTEREST_MAX);
  const followUp = oneLine(raw.followUp, FOLLOW_UP_MAX_CHARS) || null;
  if (!headline || !body) throw new Error("visit brief: model returned an empty headline or body");
  return { headline, body, interests, highlights, followUp };
}

// ---------------------------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------------------------

let promptCache: { system: string; user: string } | null = null;

async function loadPrompts(): Promise<{ system: string; user: string }> {
  if (promptCache) return promptCache;
  const [system, user] = await Promise.all([readFile(SYSTEM_PROMPT_PATH, "utf8"), readFile(USER_PROMPT_PATH, "utf8")]);
  promptCache = { system: system.trim(), user: user.trim() };
  return promptCache;
}

/**
 * Flatten every typed-in string before it goes into the JSON block, so a name cannot carry a line
 * break that ends the code fence or a run of whitespace that pads the prompt.
 */
export function sanitizeRecord(record: VisitBriefRecord): VisitBriefRecord {
  // Backticks go too: a name is never code, and three of them inside the JSON block would read as
  // the end of the fence to a model skimming the prompt.
  const name = (v: string | null): string | null => (v ? oneLine(v.replace(/`/g, ""), NAME_MAX) || null : null);
  return {
    ...record,
    link: { ...record.link, label: name(record.link.label), audience: name(record.link.audience) },
    viewer: { ...record.viewer, name: name(record.viewer.name), email: name(record.viewer.email) },
    visit: {
      ...record.visit,
      documents: record.visit.documents.map((d) => ({ ...d, title: oneLine(d.title, 200) || "Untitled" })),
    },
    outline: record.outline
      ? Object.fromEntries(
          Object.entries(record.outline).map(([title, entries]) => [
            oneLine(title, 200) || "Untitled",
            entries.map((e) => ({
              page: e.page,
              heading: e.heading ? oneLine(e.heading, 120) : null,
              excerpt: e.excerpt ? oneLine(e.excerpt, 240) : null,
              ...(e.text ? { text: oneLine(e.text.replace(/`/g, ""), 2_500) } : {}),
            })),
          ]),
        )
      : null,
  };
}

export function buildVisitBriefUserPrompt(template: string, record: VisitBriefRecord): string {
  const json = JSON.stringify(sanitizeRecord(record), null, 2);
  return template.replace("{{RECORD}}", json);
}

// ---------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------

export type GenerateVisitBriefParams = {
  record: VisitBriefRecord;
  meta?: { userId?: string | null; docId?: string | null; projectId?: string | null };
};

/**
 * Run the model once (one retry inside the SDK) and return the normalised brief.
 *
 * Throws on any failure — the caller owns the credit reservation and refunds on a throw. Never
 * returns a fallback: a brief that says nothing is worse than the recap the caller sends instead.
 */
export async function generateVisitBrief(params: GenerateVisitBriefParams): Promise<VisitBriefResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error("visit brief: OPENAI_API_KEY is not set");
  const prompts = await loadPrompts();
  const userPrompt = buildVisitBriefUserPrompt(prompts.user, params.record);
  const startedAt = Date.now();

  const aiRunId = await startAiRun({
    kind: "visitBrief",
    provider: "openai",
    model: VISIT_BRIEF_MODEL,
    temperature: 0,
    maxRetries: 1,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt: prompts.system,
    userPrompt,
    inputTextChars: userPrompt.length,
    meta: {
      userId: params.meta?.userId ?? null,
      docId: params.meta?.docId ?? null,
      projectId: params.meta?.projectId ?? null,
    },
  });

  try {
    const { object, usage } = await generateObject({
      model: openai(VISIT_BRIEF_MODEL),
      providerOptions: OPENAI_PROVIDER_OPTIONS,
      schema: VisitBriefGenerationSchema,
      temperature: 0,
      maxRetries: 1,
      system: prompts.system,
      prompt: userPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const output = normalizeVisitBriefOutput(object);
    const latencyMs = Date.now() - startedAt;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);
    const telemetry: VisitBriefTelemetry = {
      provider: "openai",
      modelRoute: VISIT_BRIEF_MODEL,
      promptTokens: num(usage?.inputTokens),
      completionTokens: num(usage?.outputTokens),
      totalTokens: num(usage?.totalTokens),
      latencyMs,
      retriesCount: 0,
    };
    await completeAiRun(aiRunId, { durationMs: latencyMs, outputObject: object, outputText: JSON.stringify(output) });
    return { output, telemetry, aiRunId: aiRunId ? String(aiRunId) : null };
  } catch (err) {
    // `AI_NoObjectGeneratedError` carries the raw text the model returned; keep it on the run so a
    // schema mismatch can be read rather than guessed at.
    const raw = err && typeof err === "object" && typeof (err as { text?: unknown }).text === "string" ? (err as { text: string }).text : null;
    await failAiRun(aiRunId, { durationMs: Date.now() - startedAt, error: err, outputText: raw });
    throw err;
  }
}
