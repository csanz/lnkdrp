/**
 * Review agent test runner (thesis vs deck relevancy).
 *
 * Purpose: Load `review.tests.json`, run the model with the configured prompts,
 * and assert the expected structured outputs.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import readline from "node:readline/promises";

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

type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

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

export type RunReviewTestsOptions = {
  listOnly?: boolean;
  runAll?: boolean;
  groupName?: string | null;
  testName?: string | null;
  verbose?: boolean;
};

export async function runReviewTests(
  opts: RunReviewTestsOptions,
): Promise<{ ok: boolean; total: number; passed: number; failed: number }> {
  const baseDir = path.resolve(process.cwd(), "tests/agent/review");
  const cfgPath = path.join(baseDir, "review.tests.json");
  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = ReviewTestsJsonSchema.parse(JSON.parse(raw)) as ReviewTestsConfig;

  if (opts.listOnly) {
    console.log("Available review test groups/tests:\n");
    cfg.testGroups.forEach((g, gi) => {
      console.log(`${gi + 1}. ${g.name}${g.description ? ` — ${g.description}` : ""}`);
      g.tests.forEach((t, ti) => {
        console.log(`   ${ti + 1}) ${t.name}`);
      });
      console.log("");
    });
    return { ok: true, total: 0, passed: 0, failed: 0 };
  }

  const selected = await selectTests(cfg, opts);
  if (selected.length === 0) {
    console.error("No tests selected.");
    return { ok: false, total: 0, passed: 0, failed: 0 };
  }

  const defaultModelName = (process.env.REVIEW_TEST_MODEL ?? "gpt-4o-mini").trim();
  const defaultTemperature = 0;
  const maxRetries = 2;

  let passed = 0;
  let failed = 0;

  for (const item of selected) {
    const modelName = (item.group.model ?? defaultModelName).trim();
    const temperature =
      typeof item.group.temperature === "number" ? item.group.temperature : defaultTemperature;

    const out = await runOne({
      baseDir,
      group: item.group,
      test: item.test,
      modelName,
      temperature,
      maxRetries,
      verbose: Boolean(opts.verbose),
    });

    const expected = item.test.expected_output;
    const ok =
      out.stage_match === expected.stage_match && out.relevancy === expected.relevancy;

    if (ok) passed++;
    else failed++;

    const status = ok ? "PASS" : "FAIL";
    console.log(
      `[${status}] ${item.group.name} :: ${item.test.name}  (expected stage_match=${expected.stage_match}, relevancy=${expected.relevancy}; got stage_match=${out.stage_match}, relevancy=${out.relevancy})`,
    );

    if (!ok || opts.verbose) {
      console.log(JSON.stringify(out, null, 2));
      console.log("");
    }
  }

  const total = passed + failed;
  console.log(`\nSummary: ${passed}/${total} passed${failed ? ` (${failed} failed)` : ""}`);
  return { ok: failed === 0, total, passed, failed };
}

async function selectTests(
  cfg: ReviewTestsConfig,
  opts: RunReviewTestsOptions,
): Promise<Array<{ group: ReviewTestsConfig["testGroups"][number]; test: ReviewTestsConfig["testGroups"][number]["tests"][number] }>> {
  // Non-interactive selectors
  if (opts.groupName || opts.testName || opts.runAll) {
    const groups = opts.groupName
      ? cfg.testGroups.filter((g) => g.name === opts.groupName)
      : cfg.testGroups;

    const selected: Array<{
      group: ReviewTestsConfig["testGroups"][number];
      test: ReviewTestsConfig["testGroups"][number]["tests"][number];
    }> = [];

    for (const g of groups) {
      const tests = opts.testName
        ? g.tests.filter((t) => t.name === opts.testName)
        : g.tests;
      for (const t of tests) selected.push({ group: g, test: t });
    }
    return selected;
  }

  // Interactive selection
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Review agent tests\n");
    cfg.testGroups.forEach((g, gi) => {
      console.log(`${gi + 1}. ${g.name}${g.description ? ` — ${g.description}` : ""}`);
    });

    const groupAns = (await rl.question("\nChoose a group number (or 'a' for all): ")).trim();
    const groupsToRun =
      groupAns.toLowerCase() === "a"
        ? cfg.testGroups
        : (() => {
            const n = Number(groupAns);
            const idx = Number.isFinite(n) ? n - 1 : -1;
            const g = cfg.testGroups[idx];
            return g ? [g] : [];
          })();

    if (groupsToRun.length === 0) return [];

    if (groupsToRun.length > 1) {
      // all groups selected
      return groupsToRun.flatMap((g) => g.tests.map((t) => ({ group: g, test: t })));
    }

    const g = groupsToRun[0];
    console.log(`\n${g.name} tests:`);
    g.tests.forEach((t, ti) => console.log(`${ti + 1}) ${t.name}`));
    const testAns = (await rl.question("\nChoose a test number (or 'a' for all): ")).trim();
    if (testAns.toLowerCase() === "a") return g.tests.map((t) => ({ group: g, test: t }));
    const tn = Number(testAns);
    const tIdx = Number.isFinite(tn) ? tn - 1 : -1;
    const t = g.tests[tIdx];
    return t ? [{ group: g, test: t }] : [];
  } finally {
    rl.close();
  }
}

async function runOne(params: {
  baseDir: string;
  group: ReviewTestsConfig["testGroups"][number];
  test: ReviewTestsConfig["testGroups"][number]["tests"][number];
  modelName: string;
  temperature: number;
  maxRetries: number;
  verbose: boolean;
}): Promise<ReviewOutput> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set. Run: OPENAI_API_KEY=... npm run tests:agent",
    );
  }

  const { baseDir, group, test } = params;
  const systemPath = path.join(baseDir, group.prompts.system);
  const userPath = path.join(baseDir, group.prompts.user);
  const thesisPath = path.join(baseDir, test.thesis_file);
  const deckPath = path.join(baseDir, test.deck_file);

  const system = fs.readFileSync(systemPath, "utf8").trim();
  const userTemplate = fs.readFileSync(userPath, "utf8").trim();
  const thesis = fs.readFileSync(thesisPath, "utf8").trim();
  const deck = fs.readFileSync(deckPath, "utf8").trim();

  const prompt = fillUserPrompt({
    template: userTemplate,
    investorThesis: thesis,
    investmentDeck: deck,
    stage: test.stage,
  });

  if (params.verbose) {
    console.log(`\n--- Prompt (debug) :: ${group.name} :: ${test.name} ---\n`);
    console.log(prompt);
    console.log("\n--- /Prompt ---\n");
  }

  const { object } = await generateObject({
    model: openai(params.modelName),
    schema: ReviewOutputSchema,
    temperature: params.temperature,
    maxRetries: params.maxRetries,
    system,
    prompt,
  });

  return object as ReviewOutput;
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

  // If a stage is provided by the test config, inject it into the template's
  // stage section (so we don't add a second, potentially conflicting stage line).
  const stageHint = normalizeStageHint(input.stage);
  if (!stageHint) return out.trim();

  // Replace the first occurrence of the stage "options" line with our hint.
  // Template line currently: "Pre-seed / Seed / Series A / Series B+"
  return out.replace(
    /Pre-seed\s*\/\s*Seed\s*\/\s*Series\s*A\s*\/\s*Series\s*B\+/i,
    stageHint,
  ).trim();
}

function normalizeStageHint(stageRaw: string): string | null {
  const s = (stageRaw ?? "").trim().toLowerCase();
  if (!s) return null;
  // Treat early stage as a range so the model doesn't over-index on a single label.
  if (s === "pre-seed" || s === "preseed" || s === "seed") return "Pre-seed / Seed";
  if (s === "series a" || s === "series_a" || s === "a") return "Series A";
  if (s === "series b" || s === "series_b" || s === "b" || s.includes("b+")) return "Series B+";
  // Fallback: title-case-ish
  return stageRaw.trim();
}


