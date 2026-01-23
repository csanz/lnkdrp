/**
 * AI-powered document analysis for PDF text.
 *
 * Produces metadata (summary, tags, SEO fields, page slugs, and project routing)
 * from extracted PDF text. The model output is validated/normalized via Zod and
 * failures degrade gracefully (returns a valid "empty" snapshot instead of throwing).
 */
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { Types } from "mongoose";
import { completeAiRun, failAiRun, startAiRun } from "@/lib/ai/aiRunRecorder";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CATEGORY_VALUES = [
  "fundraising_pitch",
  "sales_pitch",
  "product_overview",
  "technical_whitepaper",
  "business_plan",
  "investor_update",
  "financial_report",
  "market_research",
  "internal_strategy",
  "partnership_proposal",
  "marketing_material",
  "training_or_manual",
  "legal_document",
  "resume_or_profile",
  "academic_paper",
  "other",
] as const;

const INTENDED_AUDIENCE_VALUES = [
  "investors",
  "customers",
  "partners",
  "internal",
  "general",
  "unknown",
] as const;

const STAGE_VALUES = [
  "idea",
  "pre-seed",
  "seed",
  "series_a",
  "growth",
  "mature",
  "unknown",
] as const;

const TONE_VALUES = ["formal", "persuasive", "technical", "marketing", "internal", "mixed"] as const;

const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

/**
 * Strict validated shape of persisted AI doc analysis output.
 *
 * Exists to ensure downstream UI + routing code can rely on stable keys/types even when the model
 * produces imperfect JSON. Parsing failures throw Zod errors.
 */
export const AiDocAnalysisSchema = z
  .object({
    one_liner: z.string(),
    core_problem_or_need: z.string(),
    solution_summary: z.string(),
    primary_capabilities_or_scope: z.array(z.string()),
    intended_use_or_context: z.string(),
    outcomes_or_value: z.string(),
    maturity_or_status: z.string(),
    meta_title: z.string(),
    meta_description: z.string(),
    summary: z.string(),
    doc_name: z.string(),
    category: z.enum(CATEGORY_VALUES),
    page_slugs: z.array(
      z.object({
        page_number: z.number().int().min(1),
        slug: z.string().min(1),
      }),
    ),
    tags: z.array(z.string()),
    document_purpose: z.string(),
    intended_audience: z.enum(INTENDED_AUDIENCE_VALUES),
    company_or_project_name: z.string(),
    company_url: z.string(),
    contact_name: z.string(),
    contact_email: z.string(),
    contact_url: z.string(),
    industry: z.string(),
    stage: z.enum(STAGE_VALUES),
    key_metrics: z.array(z.string()),
    ask: z.string(),
    tone: z.enum(TONE_VALUES),
    confidence_level: z.enum(CONFIDENCE_VALUES),
    structure_signals: z.array(z.string()),
    /**
     * Project auto-routing (multi-project):
     * List all relevant projects (subset of the provided project list) that this doc should belong to.
     *
     * NOTE: Server-side logic may still gate auto-assignment based on per-project settings.
     */
    relevant_projects: z.array(
      z.object({
        project_id: z.string(),
        project_name: z.string(),
      }),
    ),
  })
  .strict();

export type AiDocAnalysis = z.infer<typeof AiDocAnalysisSchema>;

/**
 * Schema used for model output validation/repair.
 *
 * Why this exists:
 * - `generateObject()` validates the model output against the schema and may "repair" it.
 * - In practice, models sometimes output nulls / omit keys / return slightly-off enums.
 * - A strict schema here causes `generateObject()` to fail hard ("No object generated").
 *
 * So we accept a looser shape for generation, then normalize into the strict schema we persist.
 */
const AiDocAnalysisGenerationSchema = z
  .object({
    one_liner: z.string().nullable().optional(),
    core_problem_or_need: z.string().nullable().optional(),
    solution_summary: z.string().nullable().optional(),
    primary_capabilities_or_scope: z.array(z.string()).nullable().optional(),
    intended_use_or_context: z.string().nullable().optional(),
    outcomes_or_value: z.string().nullable().optional(),
    maturity_or_status: z.string().nullable().optional(),
    meta_title: z.string().nullable().optional(),
    meta_description: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    doc_name: z.string().nullable().optional(),
    // Accept any string; normalize into our enum.
    category: z.string().nullable().optional(),
    page_slugs: z
      .array(
        z.object({
          page_number: z.number().nullable().optional(),
          slug: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
    tags: z.array(z.string()).nullable().optional(),
    document_purpose: z.string().nullable().optional(),
    intended_audience: z.string().nullable().optional(),
    company_or_project_name: z.string().nullable().optional(),
    company_url: z.string().nullable().optional(),
    contact_name: z.string().nullable().optional(),
    contact_email: z.string().nullable().optional(),
    contact_url: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    key_metrics: z.array(z.string()).nullable().optional(),
    ask: z.string().nullable().optional(),
    tone: z.string().nullable().optional(),
    confidence_level: z.string().nullable().optional(),
    structure_signals: z.array(z.string()).nullable().optional(),
    relevant_projects: z
      .array(
        z.object({
          project_id: z.string().nullable().optional(),
          project_name: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

/** Narrow `unknown` to a plain object record (non-null, non-array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Coerce an unknown value into a string (empty string for non-strings). */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Coerce an unknown value into an integer (or null if invalid). */
function asInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.floor(v);
}

/** Pick a string enum value (falls back when the value is missing/invalid). */
function pickEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

/** Normalize an unknown value into a trimmed array of strings. */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a fallback list of page slugs from detected page numbers.
 * Used when the model output omits page slugs.
 */
function buildDefaultPageSlugs(pages?: Array<{ page_number: number; text: string }>): Array<{
  page_number: number;
  slug: string;
}> {
  const p = Array.isArray(pages) ? pages : [];
  const nums = p.map((x) => (typeof x?.page_number === "number" ? Math.floor(x.page_number) : null)).filter(Boolean) as number[];
  const max = nums.length ? Math.max(...nums) : 0;
  if (!max) return [];
  const out: Array<{ page_number: number; slug: string }> = [];
  for (let i = 1; i <= max; i++) {
    out.push({ page_number: i, slug: i === max ? "last-page" : `page-${i}` });
  }
  return out;
}

/**
 * Normalize model output into a strict `AiDocAnalysis` (never returns null).
 * Accepts loose model output and repairs common issues (nulls, missing keys, bad enums).
 */
function normalizeAiDocAnalysis(raw: unknown, pages?: Array<{ page_number: number; text: string }>): AiDocAnalysis {
  const r = isRecord(raw) ? raw : {};

  const rawPageSlugs = Array.isArray(r.page_slugs) ? (r.page_slugs as unknown[]) : [];
  const cleanedPageSlugs = rawPageSlugs
    .map((x) => (isRecord(x) ? x : null))
    .filter(Boolean)
    .map((x) => ({
      page_number: Math.max(1, asInt((x as Record<string, unknown>).page_number) ?? 1),
      slug: asString((x as Record<string, unknown>).slug).trim(),
    }))
    .filter((p) => Boolean(p.slug));

  const fallbackPageSlugs = buildDefaultPageSlugs(pages);
  const page_slugs = cleanedPageSlugs.length ? cleanedPageSlugs : fallbackPageSlugs;

  const relevant_projects = Array.isArray(r.relevant_projects)
    ? (r.relevant_projects as unknown[])
        .map((x) => (isRecord(x) ? x : null))
        .filter(Boolean)
        .map((x) => ({
          project_id: asString((x as Record<string, unknown>).project_id),
          project_name: asString((x as Record<string, unknown>).project_name),
        }))
        .filter((p) => Boolean(p.project_id) && Boolean(p.project_name))
    : [];

  return AiDocAnalysisSchema.parse({
    one_liner: asString(r.one_liner),
    core_problem_or_need: asString(r.core_problem_or_need),
    solution_summary: asString(r.solution_summary),
    primary_capabilities_or_scope: normalizeStringArray(r.primary_capabilities_or_scope),
    intended_use_or_context: asString(r.intended_use_or_context),
    outcomes_or_value: asString(r.outcomes_or_value),
    maturity_or_status: asString(r.maturity_or_status),
    meta_title: asString(r.meta_title),
    meta_description: asString(r.meta_description),
    summary: asString(r.summary),
    doc_name: asString(r.doc_name),
    category: pickEnum(r.category, CATEGORY_VALUES, "other"),
    page_slugs,
    tags: normalizeStringArray(r.tags),
    document_purpose: asString(r.document_purpose),
    intended_audience: pickEnum(r.intended_audience, INTENDED_AUDIENCE_VALUES, "unknown"),
    company_or_project_name: asString(r.company_or_project_name),
    company_url: asString(r.company_url),
    contact_name: asString(r.contact_name),
    contact_email: asString(r.contact_email),
    contact_url: asString(r.contact_url),
    industry: asString(r.industry),
    stage: pickEnum(r.stage, STAGE_VALUES, "unknown"),
    key_metrics: normalizeStringArray(r.key_metrics),
    ask: asString(r.ask),
    tone: pickEnum(r.tone, TONE_VALUES, "mixed"),
    confidence_level: pickEnum(r.confidence_level, CONFIDENCE_VALUES, "low"),
    structure_signals: normalizeStringArray(r.structure_signals),
    relevant_projects,
  });
}

const PROMPTS_MD_DIR = path.join(process.cwd(), "src/lib/prompts");
const SYSTEM_PROMPT_PATH = path.join(PROMPTS_MD_DIR, "analyzePdfText-system.md");
const USER_PROMPT_PATH = path.join(PROMPTS_MD_DIR, "analyzePdfText-user.md");
// Config is not a prompt template; keep it co-located with the analysis code.
const CONFIG_DIR = path.join(process.cwd(), "src/lib/ai/prompts");
const CONFIG_PATH = path.join(CONFIG_DIR, "analyzePdfText-config.json");

let cachedPrompts: { system: string; user: string } | null = null;
/** Load (and cache) system/user prompt templates from disk. */
async function loadPrompts(): Promise<{ system: string; user: string }> {
  if (cachedPrompts) return cachedPrompts;
  const [system, user] = await Promise.all([
    readFile(SYSTEM_PROMPT_PATH, "utf8"),
    readFile(USER_PROMPT_PATH, "utf8"),
  ]);
  cachedPrompts = { system: system.trim(), user: user.trim() };
  return cachedPrompts;
}

type AnalyzePdfTextConfig = {
  model: string;
  temperature?: number;
  maxRetries?: number;
  maxTokens?: number;
  stream?: boolean;
};

let cachedConfig: AnalyzePdfTextConfig | null = null;
/** Load (and cache) `analyzePdfText` runtime config from disk. */
async function loadConfig(): Promise<AnalyzePdfTextConfig> {
  if (cachedConfig) return cachedConfig;
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid analyzePdfText-config.json (expected object)");
  }
  const cfg = parsed as Partial<AnalyzePdfTextConfig>;
  if (typeof cfg.model !== "string" || !cfg.model.trim()) {
    throw new Error("Invalid analyzePdfText-config.json (missing model)");
  }
  cachedConfig = {
    model: cfg.model.trim(),
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
    maxRetries: typeof cfg.maxRetries === "number" ? cfg.maxRetries : undefined,
    maxTokens: typeof cfg.maxTokens === "number" ? cfg.maxTokens : undefined,
    stream: typeof cfg.stream === "boolean" ? cfg.stream : undefined,
  };
  return cachedConfig;
}
/** Fill the user prompt template (supports `{{PDF_TEXT}}`, `{{ORIGINAL_FILE_NAME}}`). */
function fillUserPrompt(
  template: string,
  params: { pdfText: string; originalFileName?: string | null },
): string {
  const t = template || "";
  const nameRaw = typeof params.originalFileName === "string" ? params.originalFileName.trim() : "";
  const pdfText = params.pdfText;
  let out = t;
  if (out.includes("{{ORIGINAL_FILE_NAME}}")) out = out.replace("{{ORIGINAL_FILE_NAME}}", nameRaw);
  if (out.includes("{{PDF_TEXT}}")) out = out.replace("{{PDF_TEXT}}", pdfText);
  // Backward-compat: if the template doesn't include a PDF placeholder, append the text.
  if (!t.includes("{{PDF_TEXT}}")) out = `${out}\n\n${pdfText}`.trim();
  return out.trim();
}
/** Trim and cap prompt text to keep token usage bounded (preserves head + tail). */
function trimForPrompt(input: string, max: number): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  // Keep cost bounded; preserve both beginning + end (often where the ask is).
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}
/** Build the analysis input text from per-page extracts (preferred) or fullText. */
function buildPrompt(input: {
  fullText?: string | null;
  pages?: Array<{ page_number: number; text: string }>;
  qualityTier: "basic" | "standard" | "advanced";
}): string {
  const max =
    input.qualityTier === "advanced" ? 50_000 : input.qualityTier === "standard" ? 35_000 : 20_000;
  const pages = (input.pages ?? []).filter((p) => p && typeof p.text === "string");
  if (pages.length) {
    const lines: string[] = [];
    for (const p of pages) {
      lines.push(`--- PAGE ${p.page_number} ---`);
      lines.push(trimForPrompt(p.text, max));
      lines.push("");
    }
    return trimForPrompt(lines.join("\n"), max);
  }
  return trimForPrompt(input.fullText ?? "", max);
}

type ProjectPromptContext = {
  id: string;
  name: string;
  description: string;
  autoAddFiles: boolean;
};
/** Build an instruction/context block listing the user's projects for routing. */
function buildProjectsContextBlock(params: {
  projects?: ProjectPromptContext[] | null;
  existingProjectIds?: string[] | null;
  isReplacement?: boolean;
}): string {
  const projects = Array.isArray(params.projects) ? params.projects : [];
  const existing = Array.isArray(params.existingProjectIds) ? params.existingProjectIds : [];
  const isReplacement = Boolean(params.isReplacement);

  // Keep prompt size bounded even if a user has lots of projects.
  // We'll include all projects up to a reasonable cap (and prioritize described projects first).
  const sorted = projects
    .slice()
    .sort((a, b) => {
      const aHas = Boolean(a.description?.trim());
      const bHas = Boolean(b.description?.trim());
      if (aHas !== bHas) return aHas ? -1 : 1;
      const aAuto = Boolean(a.autoAddFiles);
      const bAuto = Boolean(b.autoAddFiles);
      if (aAuto !== bAuto) return aAuto ? -1 : 1;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  const capped = sorted.slice(0, 200);

  const ctx = capped.map((p) => ({
    project_id: p.id,
    project_name: p.name,
    description: p.description ?? "",
    auto_add_files: Boolean(p.autoAddFiles),
  }));

  return [
    "## Project routing",
    "You are given the user's existing projects below.",
    "",
    "Rules:",
    "- You MUST return `relevant_projects` as an array of {project_id, project_name}.",
    "- `project_id` MUST match one of the provided `project_id` values exactly.",
    "- Only include projects that have `auto_add_files: true` AND a non-empty `description`, unless the doc is already in that project.",
    "- If none apply, return `[]`.",
    "",
    `This upload is a replacement: ${isReplacement ? "true" : "false"}`,
    `Doc currently belongs to project IDs: ${JSON.stringify(existing)}`,
    "",
    "Projects (JSON):",
    JSON.stringify(ctx, null, 2),
  ].join("\n");
}
/**
 * Analyze extracted PDF text and return a normalized `AiDocAnalysis`.
 *
 * Returns null when AI is disabled (`OPENAI_API_KEY` missing) or when there is no usable text.
 * Side effects: records an AI run (start/complete/fail) for observability; never throws to callers
 * on model/validation failures (falls back to a valid empty snapshot instead).
 */
export async function analyzePdfText(input: {
  fullText?: string | null;
  pages?: Array<{ page_number: number; text: string }>;
  originalFileName?: string | null;
  projects?: ProjectPromptContext[] | null;
  existingProjectIds?: string[] | null;
  isReplacement?: boolean;
  qualityTier?: "basic" | "standard" | "advanced";
  meta?: {
    userId?: string | null;
    projectId?: string | null;
    projectIds?: string[] | null;
    docId?: string | null;
    uploadId?: string | null;
    uploadVersion?: number | null;
  } | null;
}): Promise<AiDocAnalysis | null> {
  // If key isn't configured, treat as "AI disabled" rather than failing uploads.
  if (!process.env.OPENAI_API_KEY) return null;

  const qualityTier = input.qualityTier ?? "basic";
  const pdfText = buildPrompt({ ...input, qualityTier });
  if (!pdfText) return null;

  const [prompts, cfg] = await Promise.all([loadPrompts(), loadConfig()]);
  const userPrompt = fillUserPrompt(prompts.user, {
    pdfText,
    originalFileName: input.originalFileName ?? null,
  });
  const projectsBlock = buildProjectsContextBlock({
    projects: input.projects ?? null,
    existingProjectIds: input.existingProjectIds ?? null,
    isReplacement: input.isReplacement ?? false,
  });
  const system = `${prompts.system}\n\nIMPORTANT: Never output null. Use "" for strings and [] for arrays.\n\n${projectsBlock}`.trim();

  // We occasionally see the model output JSON that is close-but-not-valid for the strict schema
  // (nulls, slightly wrong enum values, etc.), which causes generateObject() to throw.
  // To keep the upload pipeline productive, we normalize into the strict schema and fall back
  // to a valid "empty" snapshot if all AI attempts fail.
  const maxTokensCfg = typeof cfg.maxTokens === "number" ? cfg.maxTokens : undefined;
  const maxTokensRetry = Math.max(maxTokensCfg ?? 0, 2500) || undefined;
  const startedAt = Date.now();
  const meta = input.meta ?? null;
  const aiRunId = await startAiRun({
    kind: "analyzePdfText",
    provider: "openai",
    model: cfg.model,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0,
    maxRetries:
      qualityTier === "advanced"
        ? 2
        : qualityTier === "standard"
          ? 1
          : 0,
    maxTokens: typeof maxTokensCfg === "number" ? maxTokensCfg : null,
    systemPrompt: system,
    userPrompt,
    inputTextChars: userPrompt.length,
    meta,
  });

  try {
    const { object } = await generateObject({
      model: openai(cfg.model),
      schema: AiDocAnalysisGenerationSchema,
      temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0,
      maxRetries:
        qualityTier === "advanced"
          ? 2
          : qualityTier === "standard"
            ? 1
            : 0,
      system,
      prompt: userPrompt,
      ...(typeof maxTokensCfg === "number" ? { maxTokens: maxTokensCfg } : {}),
    });
    const normalized = normalizeAiDocAnalysis(object, input.pages);
    await completeAiRun(aiRunId, {
      durationMs: Date.now() - startedAt,
      outputObject: object,
      outputText: JSON.stringify(normalized),
    });
    return normalized;
  } catch {
    // Retry once with a higher token budget to reduce truncation-related JSON/schema failures.
    try {
      const { object } = await generateObject({
        model: openai(cfg.model),
        schema: AiDocAnalysisGenerationSchema,
        temperature: 0,
        maxRetries: 0,
        system,
        prompt: userPrompt,
        ...(typeof maxTokensRetry === "number" ? { maxTokens: maxTokensRetry } : {}),
      });
      const normalized = normalizeAiDocAnalysis(object, input.pages);
      await completeAiRun(aiRunId, {
        durationMs: Date.now() - startedAt,
        outputObject: object,
        outputText: JSON.stringify(normalized),
      });
      return normalized;
    } catch (e2) {
      // Last resort: return a valid snapshot so downstream normalization logic can still populate
      // fields (ask/key_metrics/meta) without treating AI as "missing".
      const fallback = normalizeAiDocAnalysis({}, input.pages);
      // Preserve signal that something went wrong via server logs.
      // eslint-disable-next-line no-console
      console.warn("[analyzePdfText] failed; returning fallback snapshot", {
        message: e2 instanceof Error ? e2.message : String(e2),
      });
      await failAiRun(aiRunId, {
        durationMs: Date.now() - startedAt,
        outputText: JSON.stringify(fallback),
        error: e2,
      });
      return fallback;
    }
  }
}




