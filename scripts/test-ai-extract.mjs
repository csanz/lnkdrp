#!/usr/bin/env node
/**
 * Test AI extraction against a PDF-extracted text file.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/test-ai-extract.mjs [txtPath]
 *
 * Examples:
 *   npm run test:ai-extract
 *   npm run test:ai-extract -- tmp/usavx.txt
 *   node scripts/test-ai-extract.mjs --pdf public/sample/usavx.pdf
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const PROMPTS_DIR = path.resolve(process.cwd(), "src/lib/ai/prompts");
const SYSTEM_PROMPT_PATH = path.join(PROMPTS_DIR, "analyzePdfText-system.md");
const USER_PROMPT_PATH = path.join(PROMPTS_DIR, "analyzePdfText-user.md");
const CONFIG_PATH = path.join(PROMPTS_DIR, "analyzePdfText-config.json");

/**
 * Print usage instructions for test-ai-extract.mjs and exit.
 */
function usage(exitCode = 1) {
  console.error(
    `
Usage:
  node scripts/test-ai-extract.mjs [txtPath]
  node scripts/test-ai-extract.mjs --pdf <pdfPath>

Notes:
  - Uses OPENAI_API_KEY (loadable via .env / .env.local by dotenv)
  - Defaults txtPath to tmp/usavx.txt
`.trim(),
  );
  process.exit(exitCode);
}

const AnalysisSchema = z
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
    category: z.enum([
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
    ]),
    page_slugs: z.array(
      z.object({
        page_number: z.number().int().min(1),
        slug: z.string().nullable(),
      }),
    ),
    tags: z.array(z.string()),
    document_purpose: z.string(),
    intended_audience: z.enum([
      "investors",
      "customers",
      "partners",
      "internal",
      "general",
      "unknown",
    ]),
    company_or_project_name: z.string(),
    industry: z.string(),
    stage: z.enum([
      "idea",
      "pre-seed",
      "seed",
      "series_a",
      "growth",
      "mature",
      "unknown",
    ]),
    key_metrics: z.array(z.string()),
    ask: z.string(),
    tone: z.enum(["formal", "persuasive", "technical", "marketing", "internal", "mixed"]),
    confidence_level: z.enum(["low", "medium", "high"]),
    structure_signals: z.array(z.string()),
  })
  .strict();

/**
 * Load Analyze Prompts.
 */

function loadAnalyzePrompts() {
  const system = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
  const user = fs.readFileSync(USER_PROMPT_PATH, "utf8").trim();
  return { system, user };
}

/**
 * Load Analyze Config.
 */

function loadAnalyzeConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg || typeof cfg !== "object") throw new Error("Invalid analyzePdfText-config.json");
  if (typeof cfg.model !== "string" || !cfg.model.trim()) {
    throw new Error("Invalid analyzePdfText-config.json: missing model");
  }
  return {
    model: cfg.model.trim(),
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0,
    maxRetries: typeof cfg.maxRetries === "number" ? cfg.maxRetries : 2,
    maxTokens: typeof cfg.maxTokens === "number" ? cfg.maxTokens : undefined,
    stream: typeof cfg.stream === "boolean" ? cfg.stream : undefined,
  };
}

/**
 * Fill User Prompt.
 */

function fillUserPrompt(template, pdfText) {
  const t = (template ?? "").toString();
  if (t.includes("{{PDF_TEXT}}")) return t.replace("{{PDF_TEXT}}", pdfText);
  return `${t}\n\n${pdfText}`.trim();
}

/**
 * Extract per-page text using PDF.js (Node runtime, disable worker).
 *
 * This is slower than `pdf-parse` but gives page boundaries, which is useful for
 * page-level slugging.
 */
async function extractPagesFromPdf(pdfPath) {
  const { readFileSync } = await import("node:fs");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages || 0;
  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = (content.items || [])
      .map((it) => (it && typeof it.str === "string" ? it.str : ""))
      .filter(Boolean)
      .join(" ");
    pages.push({ page_number: i, text });
  }
  return pages;
}

/**
 * Entry point:
 * - load env vars (OPENAI_API_KEY)
 * - build a prompt from either a txt file or a PDF
 * - call the model and print structured JSON
 */
async function main() {
  // Load env vars from .env and .env.local (if present)
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

  // Shared analyzePdfText prompt/config (keeps test script aligned with app behavior)
  const prompts = loadAnalyzePrompts();
  const cfg = loadAnalyzeConfig();

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage(0);

  const pdfFlagIdx = args.indexOf("--pdf");
  const pdfPathArg = pdfFlagIdx >= 0 ? args[pdfFlagIdx + 1] : null;

  let promptPayload;

  if (pdfPathArg) {
    const pdfResolved = path.resolve(process.cwd(), pdfPathArg);
    if (!fs.existsSync(pdfResolved)) {
      throw new Error(`PDF file not found: ${pdfResolved}`);
    }
    const pages = await extractPagesFromPdf(pdfResolved);
    promptPayload = { pages };
  } else {
    const txtPath = args[0] ?? "tmp/usavx.txt";
    let resolved = path.resolve(process.cwd(), txtPath);
    if (!fs.existsSync(resolved)) {
      const dir = path.dirname(resolved);
      const entries = (() => {
        try {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith(".txt"))
            .map((d) => d.name)
            .sort();
        } catch {
          return [];
        }
      })();

      // If there's exactly one .txt available in the folder, fall back to it.
      if (entries.length === 1) {
        const fallback = path.join(dir, entries[0]);
        try {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.copyFileSync(fallback, resolved);
          console.warn(
            `Input text file not found: ${resolved}\nCreated it by copying: ${fallback}`,
          );
        } catch (e) {
          console.warn(
            `Input text file not found: ${resolved}\nCould not create it from: ${fallback}\nReason: ${
              e instanceof Error ? e.message : String(e)
            }\nFalling back to: ${fallback}`,
          );
          resolved = fallback;
        }
      } else {
        const hint = entries.length
          ? `\n\nAvailable .txt files in ${dir}:\n- ${entries.join("\n- ")}`
          : "";
        throw new Error(
          `Input text file not found: ${resolved}\n\nRun:\n  npm run test:ai-extract\nor:\n  npm run test:ai-extract -- tmp/usavx.txt${hint}`,
        );
      }
    }

    const pdfText = fs.readFileSync(resolved, "utf8");
    promptPayload = { fullText: pdfText };
  }

  const pdfText = (() => {
    if (promptPayload.pages && Array.isArray(promptPayload.pages)) {
      const lines = [];
      for (const p of promptPayload.pages) {
        lines.push(`--- PAGE ${p.page_number} ---`);
        lines.push((p.text ?? "").toString());
        lines.push("");
      }
      return lines.join("\n");
    }
    return (promptPayload.fullText ?? "").toString();
  })();

  const prompt = fillUserPrompt(prompts.user, pdfText);

  const { object } = await generateObject({
    model: openai(cfg.model),
    schema: AnalysisSchema,
    temperature: cfg.temperature,
    maxRetries: cfg.maxRetries,
    system: prompts.system,
    prompt,
    ...(typeof cfg.maxTokens === "number" ? { maxTokens: cfg.maxTokens } : {}),
  });

  console.log(JSON.stringify(object, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

