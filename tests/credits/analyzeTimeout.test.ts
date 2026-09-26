import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The summary's model calls are bounded.
 *
 * `analyzePdfText` took no abort signal and set none on either `generateObject` call, so a hung
 * provider ran until the function itself was killed at its 300 second limit - after the credits for
 * the summary were reserved and before anything could charge or refund them. These tests pin that
 * both attempts now carry a signal, that the retry shares the first attempt's budget rather than
 * doubling it, and that a caller's own signal wins.
 */
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("ai", () => ({ generateObject }));
vi.mock("@ai-sdk/openai", () => ({ openai: vi.fn((model: string) => ({ model })) }));
vi.mock("@/lib/ai/aiRunRecorder", () => ({
  startAiRun: vi.fn(async () => "run_1"),
  completeAiRun: vi.fn(async () => {}),
  failAiRun: vi.fn(async () => {}),
}));

import { ANALYZE_TIMEOUT_MS, analyzePdfText, isFallbackAnalysis } from "@/lib/ai/analyzePdfText";

const input = { fullText: "Acme Corp pitch deck. We raise $2M seed.", pages: [{ page_number: 1, text: "Acme Corp" }] };

/** The `abortSignal` each `generateObject` call was given, in call order. */
function signals(): unknown[] {
  return generateObject.mock.calls.map((c) => (c[0] as { abortSignal?: unknown }).abortSignal);
}

beforeEach(() => {
  generateObject.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("analyzePdfText timeout", () => {
  test("the first attempt runs under an abort signal", async () => {
    generateObject.mockResolvedValue({ object: { summary: "ok" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    await analyzePdfText(input);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(signals()[0]).toBeInstanceOf(AbortSignal);
  });

  test("the retry runs under the same signal, so two attempts cannot outlast one budget", async () => {
    generateObject
      .mockRejectedValueOnce(new Error("truncated"))
      .mockResolvedValueOnce({ object: { summary: "ok" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    await analyzePdfText(input);
    expect(generateObject).toHaveBeenCalledTimes(2);
    const [first, second] = signals();
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBe(first);
  });

  test("a caller's own signal is used instead of the default", async () => {
    const controller = new AbortController();
    generateObject.mockRejectedValue(new Error("model down"));
    const out = await analyzePdfText({ ...input, abortSignal: controller.signal });
    expect(signals()).toEqual([controller.signal, controller.signal]);
    // A failed run still degrades to the marked fallback snapshot, which the caller refunds.
    expect(isFallbackAnalysis(out)).toBe(true);
  });

  test("an already-aborted signal ends the run rather than letting it hang", async () => {
    // Stand-in for the timeout firing: the provider rejects with the signal's reason.
    const aborted = AbortSignal.abort(new Error("The operation was aborted due to timeout"));
    generateObject.mockImplementation(async (args: { abortSignal?: AbortSignal }) => {
      if (args.abortSignal?.aborted) throw args.abortSignal.reason;
      return { object: { summary: "ok" }, usage: {} };
    });
    const out = await analyzePdfText({ ...input, abortSignal: aborted });
    expect(isFallbackAnalysis(out)).toBe(true);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  test("the default ceiling matches the AI compare's, and stays under the function limit", () => {
    expect(ANALYZE_TIMEOUT_MS).toBe(90_000);
    expect(ANALYZE_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
