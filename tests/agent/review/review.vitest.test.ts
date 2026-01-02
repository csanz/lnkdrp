/**
 * Vitest suite for the "review" agent (thesis vs deck relevancy).
 *
 * Runs against `review.tests.json`.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const ReviewRelevancySchema = z.enum(["low", "medium", "high"]);

const ReviewOutputSchema = z
  .object({
    stage_match: z.boolean(),
    notes: z.string(),
    relevancy: ReviewRelevancySchema,
    relevancy_reason: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    key_open_questions: z.array(z.string()),
    summary_markdown: z.string(),
    founder_note: z.string(),
  })
  .strict();

const ReviewTestsJsonSchema = z
  .object({
    testGroups: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        model: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
        prompts: z.object({
          system: z.string().min(1),
          user: z.string().min(1),
        }),
        tests: z.array(
          z.object({
            name: z.string().min(1),
            thesis_file: z.string().min(1),
            deck_file: z.string().min(1),
            stage: z.string().min(1),
            expected_output: z.object({
              stage_match: z.boolean(),
              relevancy: ReviewRelevancySchema,
            }),
          }),
        ),
      }),
    ),
  })
  .strict();

type ReviewTestsConfig = z.infer<typeof ReviewTestsJsonSchema>;
type ReviewGroup = ReviewTestsConfig["testGroups"][number];
type ReviewTest = ReviewGroup["tests"][number];

const baseDir = path.resolve(process.cwd(), "tests/agent/review");
const cfgPath = path.join(baseDir, "review.tests.json");
const cfg = ReviewTestsJsonSchema.parse(JSON.parse(fs.readFileSync(cfgPath, "utf8"))) as ReviewTestsConfig;

function shouldWriteLogs(): boolean {
  const v = (process.env.AGENT_TEST_LOG ?? "1").toLowerCase().trim();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function logDir(): string {
  const p = (process.env.AGENT_TEST_LOG_DIR ?? "tmp/agent-tests/review").trim();
  return path.resolve(process.cwd(), p);
}

function writeRunLog(input: {
  groupName: string;
  testName: string;
  systemPromptPath: string;
  userPromptPath: string;
  thesisPath: string;
  deckPath: string;
  model: string;
  temperature: number;
  system: string;
  userTemplate: string;
  thesis: string;
  deck: string;
  prompt: string;
  openaiRequest: { model: string; temperature: number; system: string; prompt: string };
  rawText: string | null;
  parsedJson: unknown | null;
  parseError: string | null;
  expected: { stage_match: boolean; relevancy: "low" | "medium" | "high" };
}): string | null {
  if (!shouldWriteLogs()) return null;
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });

  // Keep log filenames short: primarily just the timestamp the test ran.
  // If multiple logs happen in the same second, append -2, -3, ... to avoid clobbering.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); // YYYY-MM-DD-HH-MM-SS
  let fullPath = path.join(dir, `${stamp}.json`);
  for (let n = 2; fs.existsSync(fullPath); n++) {
    fullPath = path.join(dir, `${stamp}-${n}.json`);
  }

  const payload = {
    at: new Date().toISOString(),
    group: input.groupName,
    test: input.testName,
    files: {
      system_prompt: input.systemPromptPath,
      user_prompt: input.userPromptPath,
      thesis: input.thesisPath,
      deck: input.deckPath,
    },
    model: {
      name: input.model,
      temperature: input.temperature,
    },
    expected: input.expected,
    openai_request: input.openaiRequest,
    inputs: {
      user_template: input.userTemplate,
      thesis: input.thesis,
      deck: input.deck,
    },
    prompts: {
      system: input.system,
      user_filled: input.prompt,
    },
    raw_output_text: input.rawText,
    parsed_json: input.parsedJson,
    parse_error: input.parseError,
  };

  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2));
  return fullPath;
}

function fillUserPrompt(input: {
  template: string;
  investorThesis: string;
  investmentDeck: string;
  stage: string;
}): string {
  const t = (input.template ?? "").toString();
  const out = t
    .replaceAll("{{InvestorThesis}}", input.investorThesis ?? "")
    .replaceAll("{{InvestmentDeck}}", input.investmentDeck ?? "");

  const stageHint = normalizeStageHint(input.stage);
  const withStage = stageHint
    ? out.replace(
    /Pre-seed\s*\/\s*Seed\s*\/\s*Series\s*A\s*\/\s*Series\s*B\+/i,
    stageHint,
      )
    : out;

  // Make `stage_match` unambiguous by explicitly extracting stages.
  const investorStageFocus = inferInvestorStageFocus(input.investorThesis);
  const companyStage = inferCompanyStage(input.investmentDeck, stageHint ?? null);

  const rubric = [
    "",
    "STAGE_MATCH RUBRIC (authoritative):",
    `- Investor stage focus (from thesis): ${investorStageFocus}`,
    `- Company stage (from deck): ${companyStage}`,
    `Set "stage_match" to true IFF the company stage is included in the investor stage focus.`,
    `Do NOT use business model, sector, hardware/software fit, or thesis alignment when setting "stage_match" (that's what "relevancy" is for).`,
    "",
  ].join("\n");

  return `${withStage.trim()}\n${rubric}`.trim();
}

function normalizeStageHint(stageRaw: string): string | null {
  const s = (stageRaw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "pre-seed" || s === "preseed" || s === "seed") return "Pre-seed / Seed";
  if (s === "series a" || s === "series_a" || s === "a") return "Series A";
  if (s === "series b" || s === "series_b" || s === "b" || s.includes("b+")) return "Series B+";
  return stageRaw.trim();
}

function inferInvestorStageFocus(thesis: string): string {
  const t = (thesis ?? "").toLowerCase();
  const hasPreSeed = /\bpre[-\s]?seed\b/.test(t);
  const hasSeed = /\bseed\b/.test(t);
  const hasSeriesA = /\bseries\s*a\b/.test(t) || /\bseries_a\b/.test(t);
  const hasSeriesB = /\bseries\s*b\b/.test(t) || /\bseries_b\b/.test(t) || /\bseries\s*b\+\b/.test(t);

  // Build a conservative inclusive focus set in order.
  const focus: string[] = [];
  const add = (s: string) => {
    if (!focus.includes(s)) focus.push(s);
  };

  if (hasPreSeed) add("Pre-seed");
  if (hasSeed) add("Seed");
  if (hasSeriesA) add("Series A");
  if (hasSeriesB) add("Series B+");

  // If a thesis mentions Seed and Series B (e.g. "Seed through Series B"), include Series A as the bridge.
  if (hasSeed && hasSeriesB && !hasSeriesA) add("Series A");
  // If it mentions Pre-seed and later stages, include intermediate early-stage labels.
  if (hasPreSeed && (hasSeriesA || hasSeriesB) && !hasSeed) add("Seed");
  if (hasPreSeed && hasSeriesB && !hasSeriesA) add("Series A");

  if (!focus.length) return "Unknown";
  return focus.join(" / ");
}

function inferCompanyStage(deck: string, fallbackStageHint: string | null): string {
  const t = (deck ?? "").toLowerCase();
  if (/\bpre[-\s]?seed\b/.test(t)) return "Pre-seed";
  if (/\bseed\b/.test(t)) return "Seed";
  if (/\bseries\s*a\b/.test(t)) return "Series A";
  if (/\bseries\s*b\+?\b/.test(t) || /\bseries\s*b\b/.test(t)) return "Series B+";
  if (fallbackStageHint) return fallbackStageHint;
  return "Unknown";
}

async function runOne(params: { group: ReviewGroup; test: ReviewTest }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set. Run: OPENAI_API_KEY=... npm run tests:agent",
    );
  }

  const modelName = (params.group.model ?? process.env.REVIEW_TEST_MODEL ?? "gpt-4o-mini").trim();
  const temperature = typeof params.group.temperature === "number" ? params.group.temperature : 0;
  const maxRetries = 2;

  const systemPath = path.join(baseDir, params.group.prompts.system);
  const userPath = path.join(baseDir, params.group.prompts.user);
  const thesisPath = path.join(baseDir, params.test.thesis_file);
  const deckPath = path.join(baseDir, params.test.deck_file);

  const system = fs.readFileSync(systemPath, "utf8").trim();
  const userTemplate = fs.readFileSync(userPath, "utf8").trim();
  const thesis = fs.readFileSync(thesisPath, "utf8").trim();
  const deck = fs.readFileSync(deckPath, "utf8").trim();

  const prompt = fillUserPrompt({
    template: userTemplate,
    investorThesis: thesis,
    investmentDeck: deck,
    stage: params.test.stage,
  });

  const { text } = await generateText({
    model: openai(modelName),
    temperature,
    maxRetries,
    system,
    prompt,
  });

  const rawText = (text ?? "").toString().trim();
  let parsedJson: unknown | null = null;
  let parseError: string | null = null;
  try {
    parsedJson = extractJsonObject(rawText);
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  // Validate structured output (and throw on invalid).
  const object = ReviewOutputSchema.parse(parsedJson);

  const logPath = writeRunLog({
    groupName: params.group.name,
    testName: params.test.name,
    systemPromptPath: systemPath,
    userPromptPath: userPath,
    thesisPath,
    deckPath,
    model: modelName,
    temperature,
    system,
    userTemplate,
    thesis,
    deck,
    prompt,
    openaiRequest: { model: modelName, temperature, system, prompt },
    rawText,
    parsedJson,
    parseError,
    expected: params.test.expected_output,
  });

  return { object, logPath };
}

function extractJsonObject(rawText: string): unknown {
  const t = (rawText ?? "").trim();
  if (!t) throw new Error("Model returned empty text");

  // Prefer direct parse first.
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }

  // Best-effort: extract the first {...} block.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Could not locate JSON object in output (len=${t.length})`);
  }

  const slice = t.slice(start, end + 1);
  return JSON.parse(slice);
}

describe("agent:review", () => {
  for (const group of cfg.testGroups) {
    describe(group.name, () => {
      for (const test of group.tests) {
        it(test.name, async () => {
          const res = await runOne({ group, test });
          const out = res.object;
          const expected = test.expected_output;
          const received = { stage_match: out.stage_match, relevancy: out.relevancy };
          try {
            expect(received).toEqual(expected);
          } catch (e) {
            const logRel = res.logPath ? path.relative(process.cwd(), res.logPath) : null;
            const msg = [
              `Agent output mismatch`,
              ``,
              `Expected: stage_match=${expected.stage_match}, relevancy=${expected.relevancy}`,
              `Received: stage_match=${received.stage_match}, relevancy=${received.relevancy}`,
              ``,
              `Model notes: ${String((out as any)?.notes ?? "").trim() || "(none)"}`,
              `Relevancy reason: ${String((out as any)?.relevancy_reason ?? "").trim() || "(none)"}`,
              ...(logRel ? [``, `Log: ${logRel}`] : []),
            ].join("\n");
            // Don't attach a "cause" here; it makes Vitest print a huge nested diff.
            throw new Error(msg);
          }
        });
      }
    });
  }
});


