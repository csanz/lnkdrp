import type { Reporter, SerializedError, TestCase, TestModule } from "vitest/node";

function red(s: string) {
  return `\u001b[31m${s}\u001b[0m`;
}
function green(s: string) {
  return `\u001b[32m${s}\u001b[0m`;
}
function dim(s: string) {
  return `\u001b[2m${s}\u001b[0m`;
}

/**
 * Concise reporter for interactive agent runs.
 *
 * Goal: show PASS/FAIL cleanly without stack traces/diffs.
 */
export default class AgentConciseReporter implements Reporter {
  private failed: Array<{ name: string; message: string }> = [];
  private passed = 0;
  private skipped = 0;

  onTestCaseResult(testCase: TestCase) {
    const r = testCase.result();
    if (r.state === "passed") {
      this.passed += 1;
      return;
    }
    if (r.state === "skipped") {
      this.skipped += 1;
      return;
    }
    if (r.state === "failed") {
      const err = r.errors?.[0] as any;
      const msg = (err?.message ?? "Test failed").toString().trim();
      this.failed.push({ name: testCase.fullName, message: msg });
    }
  }

  onTestRunEnd(_modules: ReadonlyArray<TestModule>, _errors: ReadonlyArray<SerializedError>, reason: any) {
    const failedCount = this.failed.length;

    if (failedCount === 0) {
      // Keep this very short; interactive users want signal, not noise.
      process.stdout.write(`${green("PASS")} ${this.passed} tests${this.skipped ? `, ${this.skipped} skipped` : ""}\n`);
      return;
    }

    process.stdout.write(`${red("FAIL")} ${failedCount} test${failedCount === 1 ? "" : "s"} failed${this.passed ? `, ${this.passed} passed` : ""}${this.skipped ? `, ${this.skipped} skipped` : ""}\n\n`);

    for (const f of this.failed) {
      process.stdout.write(`${red("✖")} ${f.name}\n`);
      process.stdout.write(`${f.message}\n`);
      process.stdout.write(`${dim("-".repeat(60))}\n`);
    }

    if (reason && reason !== "passed") {
      process.stdout.write(dim(`\n(vitest reason: ${String(reason)})\n`));
    }
  }
}


