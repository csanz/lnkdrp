#!/usr/bin/env node
/**
 * Agent test CLI entrypoint.
 *
 * Purpose: interactive harness for running agent test suites under `tests/agent/**`.
 *
 * Usage:
 *   OPENAI_API_KEY=... npm run tests:agent:cli
 *   OPENAI_API_KEY=... npm run tests:agent:cli -- --agent review --all
 *   npm run tests:agent:cli -- --agent review --list
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import dotenv from "dotenv";

import readline from "node:readline/promises";
import { z } from "zod";

function usage(exitCode = 1) {
  console.error(
    `
Usage:
  npm run tests:agent
  npm run tests:agent -- --help

Interactive:
  npm run tests:agent

Non-interactive:
  npm run tests:agent -- --list
  npm run tests:agent -- --agent review --all
  npm run tests:agent -- --agent review --group "Investor focused"
  npm run tests:agent -- --agent review --test "Thesis vs Deck - Low Relevancy"
  npm run tests:agent -- -t "Thesis vs Deck - Medium Relevancy"

Raw Vitest (direct):
  npm run tests:agent:vitest
  npm run tests:agent:vitest -- -t "Thesis vs Deck - Low Relevancy"

Options:
  --agent <name>   Agent suite to run (only "review" for now)
  --list           List available groups/tests and exit
  --all            Run all tests (no interactive prompts)
  --group <name>   Select a test group by name (exact match)
  --test <name>    Select a single test by name (exact match)
  -t <pattern>     Vitest-style test name pattern (forwarded to vitest -t)
  --testNamePattern <pattern>  Same as -t (forwarded to vitest -t)
  --concise        Use a concise Vitest reporter (clean summary; includes log path). Default is normal Vitest output.
  --verbose        Print full model outputs (and extra debug)

Env:
  OPENAI_API_KEY      Required to actually run model calls (not required for --list)
  REVIEW_TEST_MODEL   Optional (default: gpt-4o-mini)
`.trim(),
  );
  process.exit(exitCode);
}

type CliArgs = {
  agent: "review" | null;
  list: boolean;
  all: boolean;
  group: string | null;
  test: string | null;
  testNamePattern: string | null; // vitest-style -t
  concise: boolean;
  verbose: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage(0);

  const agentIdx = args.indexOf("--agent");
  const agentVal = agentIdx >= 0 ? (args[agentIdx + 1] ?? null) : null;

  const groupIdx = args.indexOf("--group");
  const groupVal = groupIdx >= 0 ? (args[groupIdx + 1] ?? null) : null;

  const testIdx = args.indexOf("--test");
  const testVal = testIdx >= 0 ? (args[testIdx + 1] ?? null) : null;

  const tIdx = args.indexOf("-t");
  const tVal = tIdx >= 0 ? (args[tIdx + 1] ?? null) : null;

  const testNamePatternIdx = args.indexOf("--testNamePattern");
  const testNamePatternVal = testNamePatternIdx >= 0 ? (args[testNamePatternIdx + 1] ?? null) : null;

  const agent = agentVal === "review" ? "review" : null;

  return {
    agent,
    list: args.includes("--list"),
    all: args.includes("--all"),
    group: groupVal && groupVal.trim() ? groupVal.trim() : null,
    test: testVal && testVal.trim() ? testVal.trim() : null,
    testNamePattern:
      (tVal && tVal.trim() ? tVal.trim() : null) ??
      (testNamePatternVal && testNamePatternVal.trim() ? testNamePatternVal.trim() : null),
    concise: args.includes("--concise"),
    verbose: args.includes("--verbose"),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ReviewTestsJsonSchema = z
  .object({
    testGroups: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        tests: z.array(z.object({ name: z.string().min(1) })),
      }),
    ),
  })
  .strict();

async function main() {
  // Keep consistent with other scripts: load .env + .env.local
  dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

  const parsed = parseArgs(process.argv);

  // For now: one option. If not provided, prompt (so the UX matches future multi-agent expansion).
  const shouldSkipAgentPrompt =
    parsed.list || parsed.all || Boolean(parsed.group) || Boolean(parsed.test) || Boolean(parsed.testNamePattern);
  const agent = parsed.agent ?? (shouldSkipAgentPrompt ? "review" : await chooseAgentInteractive());
  if (agent !== "review") {
    console.error(`Unknown agent: ${String(parsed.agent)}\n\nOnly supported: review`);
    usage(1);
  }

  const reviewCfg = loadReviewTestsConfig();

  if (parsed.list) {
    console.log("Available review test groups/tests:\n");
    reviewCfg.testGroups.forEach((g, gi) => {
      console.log(`${gi + 1}. ${g.name}${g.description ? ` — ${g.description}` : ""}`);
      g.tests.forEach((t, ti) => console.log(`   ${ti + 1}) ${t.name}`));
      console.log("");
    });
    process.exit(0);
  }

  const selection =
    parsed.all || parsed.group || parsed.test || parsed.testNamePattern
      ? { groupName: parsed.group, testName: parsed.test }
      : await chooseReviewTestInteractive(reviewCfg);

  // If user used --test (intended exact), anchor it so it doesn't match similarly-named tests.
  const exactTestPattern =
    parsed.test && parsed.test.trim() ? `${escapeRegex(parsed.test.trim())}$` : null;

  const { exitCode } = await runVitestWithSpinner({
    testFile: "tests/agent/review/review.vitest.test.ts",
    testNamePattern:
      parsed.testNamePattern ?? exactTestPattern ?? selection.testName ?? selection.groupName ?? null,
    concise: parsed.concise,
    verbose: parsed.verbose,
  });

  process.exit(exitCode);
}

async function chooseAgentInteractive(): Promise<"review"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Choose an agent:\n");
    console.log("1) review");
    const ans = (await rl.question("\nEnter choice [1]: ")).trim();
    if (ans === "" || ans === "1") return "review";
    throw new Error(`Invalid choice: ${ans}`);
  } finally {
    rl.close();
  }
}

function loadReviewTestsConfig(): z.infer<typeof ReviewTestsJsonSchema> {
  const p = path.resolve(process.cwd(), "tests/agent/review/review.tests.json");
  const raw = fs.readFileSync(p, "utf8");
  return ReviewTestsJsonSchema.parse(JSON.parse(raw));
}

async function chooseReviewTestInteractive(cfg: z.infer<typeof ReviewTestsJsonSchema>): Promise<{
  groupName: string | null;
  testName: string | null;
}> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nReview agent tests\n");
    cfg.testGroups.forEach((g, gi) => {
      console.log(`${gi + 1}. ${g.name}${g.description ? ` — ${g.description}` : ""}`);
    });

    const groupAns = (await rl.question("\nChoose a group number (or 'a' for all): ")).trim();
    if (groupAns.toLowerCase() === "a") return { groupName: null, testName: null };

    const n = Number(groupAns);
    const idx = Number.isFinite(n) ? n - 1 : -1;
    const group = cfg.testGroups[idx];
    if (!group) throw new Error(`Invalid group choice: ${groupAns}`);

    console.log(`\n${group.name} tests:`);
    group.tests.forEach((t, ti) => console.log(`${ti + 1}) ${t.name}`));
    const testAns = (await rl.question("\nChoose a test number (or 'a' for all): ")).trim();
    if (testAns.toLowerCase() === "a") return { groupName: group.name, testName: null };

    const tn = Number(testAns);
    const tIdx = Number.isFinite(tn) ? tn - 1 : -1;
    const test = group.tests[tIdx];
    if (!test) throw new Error(`Invalid test choice: ${testAns}`);
    return { groupName: group.name, testName: test.name };
  } finally {
    rl.close();
  }
}

async function runVitestWithSpinner(params: {
  testFile: string;
  testNamePattern: string | null;
  concise: boolean;
  verbose: boolean;
}): Promise<{ exitCode: number }> {
  const args: string[] = ["vitest", "run", "--config", "tests/agent/vitest.config.ts"];
  // Default experience should look like "real unit tests" → Vitest default reporter.
  // Opt-in to concise output for the interactive-friendly summary.
  const useConcise = Boolean(params.concise) && !params.verbose;
  if (params.verbose) args.push("--reporter", "verbose");
  else if (useConcise) args.push("--reporter", "tests/agent/vitest.reporter.concise.ts");
  args.push(params.testFile);
  if (params.testNamePattern) args.push("-t", params.testNamePattern);

  // Use npx so we run the locally installed vitest binary.
  const cmd = "npx";

  const child = spawn(cmd, ["--no-install", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Encourage color even if users pipe output elsewhere.
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
    },
    // Default reporter wants a TTY for best formatting/colors.
    stdio: useConcise ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });

  // Spinner: only for concise mode, and it stops the moment Vitest prints anything.
  let timer: NodeJS.Timeout | null = null;
  if (useConcise) {
    const frames = ["|", "/", "-", "\\"];
    let i = 0;
    const start = Date.now();
    timer = setInterval(() => {
      const secs = Math.max(0, Math.round((Date.now() - start) / 1000));
      process.stderr.write(`\r${frames[i++ % frames.length]} Running tests... (${secs}s)`);
    }, 120);
  }

  let sawOutput = false;
  const stopSpinner = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    process.stderr.write("\r" + " ".repeat(80) + "\r");
  };

  if (useConcise) {
    child.stdout?.on("data", (b: Buffer) => {
      if (!sawOutput) {
        sawOutput = true;
        stopSpinner();
      }
      process.stdout.write(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (!sawOutput) {
        sawOutput = true;
        stopSpinner();
      }
      process.stderr.write(b);
    });
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
  });

  stopSpinner();

  return { exitCode };
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});


