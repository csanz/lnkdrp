import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A summary that retries is billed twice and used to be recorded once.
 *
 * `analyzePdfText` calls the model a second time only because the first call failed, and a
 * `generateObject` that fails on a parse or a schema mismatch has already generated the output it
 * is being rejected for, and been charged for it. The telemetry was rebuilt from whichever call
 * returned last, so the most expensive runs in the product were the ones recorded as the cheapest:
 * one call's tokens, one call's cost, no sign that a second had happened.
 *
 * The customer pays the same credit either way. These tests are about what we know it cost.
 */
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));
const { completeAiRun, failAiRun } = vi.hoisted(() => ({
  // Typed with their real argument list so the assertions below can read what was recorded.
  completeAiRun: vi.fn(async (_id: unknown, _args: { usage?: unknown }) => {}),
  failAiRun: vi.fn(async (_id: unknown, _args: { usage?: unknown }) => {}),
}));

vi.mock("ai", () => ({ generateObject }));
vi.mock("@ai-sdk/openai", () => ({ openai: vi.fn((model: string) => ({ model })) }));
vi.mock("@/lib/ai/aiRunRecorder", () => ({
  startAiRun: vi.fn(async () => "run_1"),
  completeAiRun,
  failAiRun,
}));

import { analyzePdfText, analysisTelemetry, isFallbackAnalysis } from "@/lib/ai/analyzePdfText";

const input = {
  fullText: "Acme Corp pitch deck. We raise $2M seed.",
  pages: [{ page_number: 1, text: "Acme Corp" }],
};

/** The shape `AI_NoObjectGeneratedError` has: the text it produced, and the usage it was billed for. */
function noObjectGenerated(usage: Record<string, number>): Error & { usage: Record<string, number> } {
  const err = new Error("No object generated") as Error & { usage: Record<string, number> };
  err.usage = usage;
  return err;
}

beforeEach(() => {
  generateObject.mockReset();
  completeAiRun.mockClear();
  failAiRun.mockClear();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("a summary that took two calls", () => {
  test("records both calls' tokens, not just the one that worked", async () => {
    generateObject
      .mockRejectedValueOnce(noObjectGenerated({ inputTokens: 30_000, outputTokens: 800 }))
      .mockResolvedValueOnce({
        object: { summary: "A seed deck." },
        usage: { inputTokens: 30_000, outputTokens: 1_200, totalTokens: 31_200 },
      });

    const out = await analyzePdfText(input);
    expect(isFallbackAnalysis(out)).toBe(false);

    const t = analysisTelemetry(out);
    expect(t?.promptTokens).toBe(60_000);
    expect(t?.completionTokens).toBe(2_000);
    expect(t?.modelCalls).toBe(2);
    expect(t?.retriesCount).toBe(1);
  });

  test("prices both calls, so the cost is the run's and not the last attempt's", async () => {
    generateObject
      .mockRejectedValueOnce(noObjectGenerated({ inputTokens: 30_000, outputTokens: 800 }))
      .mockResolvedValueOnce({
        object: { summary: "A seed deck." },
        usage: { inputTokens: 30_000, outputTokens: 1_200, totalTokens: 31_200 },
      });

    const t = analysisTelemetry(await analyzePdfText(input));
    // Text-only, so gpt-4o-mini: 60,000 x 0.15 + 2,000 x 0.60, per million. The last call alone
    // would have been 0.00522.
    expect(t?.costUsdActual).toBeCloseTo(0.0102, 6);
  });

  test("the whole cost reaches the AiRun row, not only the ledger", async () => {
    generateObject
      .mockRejectedValueOnce(noObjectGenerated({ inputTokens: 1_000, outputTokens: 100 }))
      .mockResolvedValueOnce({ object: { summary: "ok" }, usage: { inputTokens: 1_000, outputTokens: 100 } });

    await analyzePdfText(input);
    expect(completeAiRun).toHaveBeenCalledTimes(1);
    const args = completeAiRun.mock.calls[0]?.[1] as { usage?: { promptTokens: number | null; modelCalls: number } } | undefined;
    expect(args?.usage?.promptTokens).toBe(2_000);
    expect(args?.usage?.modelCalls).toBe(2);
  });
});

describe("a summary that failed twice", () => {
  test("still writes what it spent, because nothing else will", async () => {
    // Both attempts generated output and both were billed; the customer's credit is refunded by
    // the caller, so the ledger row will never carry this. The AiRun row is the only record.
    generateObject
      .mockRejectedValueOnce(noObjectGenerated({ inputTokens: 5_000, outputTokens: 400 }))
      .mockRejectedValueOnce(noObjectGenerated({ inputTokens: 5_000, outputTokens: 400 }));

    const out = await analyzePdfText(input);
    expect(isFallbackAnalysis(out)).toBe(true);
    // The fallback snapshot carries no telemetry: it is not a summary and must not be charged.
    expect(analysisTelemetry(out)).toBeNull();

    expect(failAiRun).toHaveBeenCalledTimes(1);
    const args = failAiRun.mock.calls[0]?.[1] as { usage?: { promptTokens: number | null; costUsdActual: number | null } } | undefined;
    expect(args?.usage?.promptTokens).toBe(10_000);
    expect(args?.usage?.costUsdActual).toBeGreaterThan(0);
  });

  test("a transport failure that carries no usage records no tokens rather than zeroes", async () => {
    generateObject.mockRejectedValue(new Error("connection reset"));
    await analyzePdfText(input);
    const args = failAiRun.mock.calls[0]?.[1] as { usage?: unknown } | undefined;
    expect(args?.usage ?? null).toBeNull();
  });
});
