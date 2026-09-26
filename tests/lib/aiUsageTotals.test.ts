/**
 * One charge is not one call, and the bug these tests exist for is that the recorder used to
 * believe it was.
 *
 * `analyzePdfText` retries once after a parse failure, `reviewDocText` falls back from structured
 * output to plain text, and both attempts are billed. Each call site kept the usage of whichever
 * call returned last and dropped the rest, so the runs that cost the most were the ones recorded as
 * costing the least: the retry is only reached because the first attempt already generated (and was
 * charged for) output the schema rejected.
 */
import { describe, expect, test } from "vitest";

import { createAiUsageAccumulator } from "@/lib/ai/usageTotals";

/** The shape `AI_NoObjectGeneratedError` has: a message, the raw text, and the usage it billed. */
function noObjectGeneratedError(usage: Record<string, number>): Error & { usage: Record<string, number> } {
  const err = new Error("No object generated") as Error & { usage: Record<string, number> };
  err.usage = usage;
  return err;
}

describe("accumulating one charge", () => {
  test("sums both attempts instead of keeping the last one", () => {
    const acc = createAiUsageAccumulator();
    // Attempt one: generated output, failed the schema, billed anyway.
    acc.addFromError("gpt-4o-mini", noObjectGeneratedError({ inputTokens: 30_000, outputTokens: 800 }));
    // Attempt two: worked.
    acc.add("gpt-4o-mini", { inputTokens: 30_000, outputTokens: 1_200, totalTokens: 31_200 });

    const totals = acc.totals();
    expect(totals).not.toBeNull();
    expect(totals!.promptTokens).toBe(60_000);
    expect(totals!.completionTokens).toBe(2_000);
    expect(totals!.modelCalls).toBe(2);
    // The old behaviour would have priced only the second call, at 0.0052.
    expect(totals!.costUsdActual).toBeCloseTo(0.0102, 6);
  });

  test("a charge that never observed usage is null, so nothing downstream records a zero", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", null);
    acc.addFromError("gpt-4o", new Error("connection reset"));
    expect(acc.totals()).toBeNull();
  });

  test("a call that reported nothing does not count toward modelCalls", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { inputTokens: 100, outputTokens: 10 });
    acc.add("gpt-4o", {});
    expect(acc.totals()!.modelCalls).toBe(1);
  });
});

describe("which model actually ran", () => {
  test("reports the model that ran, not the one that was configured", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { inputTokens: 8_500, outputTokens: 400 });
    expect(acc.totals()!.modelRoute).toBe("gpt-4o");
  });

  test("a charge across two models is priced at each model's own rate", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 0 });
    acc.add("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 });

    const totals = acc.totals()!;
    expect(totals.modelRoute).toBe("gpt-4o-mini+gpt-4o");
    expect(totals.promptTokens).toBe(2_000_000);
    // 0.15 on mini plus 2.50 on gpt-4o. Pricing the flat total at either rate gives 0.30 or 5.00.
    expect(totals.costUsdActual).toBeCloseTo(2.65, 6);
  });

  test("one unpriced model makes the whole charge unpriced, tokens still recorded", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { inputTokens: 1_000, outputTokens: 100 });
    acc.add("some-new-model", { inputTokens: 5_000, outputTokens: 200 });

    const totals = acc.totals()!;
    expect(totals.promptTokens).toBe(6_000);
    expect(totals.completionTokens).toBe(300);
    // Half a cost is not a cost: reporting the priced half would read as the whole.
    expect(totals.costUsdActual).toBeNull();
  });
});

describe("token counts the provider sends oddly", () => {
  test("carries the provider's own total rather than recomputing it", () => {
    const acc = createAiUsageAccumulator();
    // Reasoning tokens make the provider's total exceed input plus output.
    acc.add("gpt-4o", { inputTokens: 100, outputTokens: 10, totalTokens: 250 });
    expect(acc.totals()!.totalTokens).toBe(250);
  });

  test("falls back to input plus output when no total was sent", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { inputTokens: 100, outputTokens: 10 });
    expect(acc.totals()!.totalTokens).toBe(110);
  });

  test("a missing count stays missing rather than becoming a zero", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { outputTokens: 10 });
    expect(acc.totals()!.promptTokens).toBeNull();
  });

  test("cached input tokens are carried through so the cost gets the discount", () => {
    const acc = createAiUsageAccumulator();
    acc.add("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 });
    const totals = acc.totals()!;
    expect(totals.cachedInputTokens).toBe(500_000);
    // 500k at 2.50 plus 500k at 1.25, per million.
    expect(totals.costUsdActual).toBeCloseTo(1.875, 6);
  });
});
