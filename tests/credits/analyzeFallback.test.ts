import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `analyzePdfText` never throws: after both model attempts fail it returns an empty snapshot so
 * the pipeline can still populate derived fields. The processing job must not charge a credit for
 * that snapshot, so the analyzer marks it (`isFallbackAnalysis`) and carries provider usage on
 * real results (`analysisTelemetry`) for the ledger.
 */
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("ai", () => ({ generateObject }));
vi.mock("@ai-sdk/openai", () => ({ openai: vi.fn((model: string) => ({ model })) }));
vi.mock("@/lib/ai/aiRunRecorder", () => ({
  startAiRun: vi.fn(async () => "run_1"),
  completeAiRun: vi.fn(async () => {}),
  failAiRun: vi.fn(async () => {}),
}));

import { analyzePdfText, analysisTelemetry, isFallbackAnalysis } from "@/lib/ai/analyzePdfText";

const input = { fullText: "Acme Corp pitch deck. We raise $2M seed.", pages: [{ page_number: 1, text: "Acme Corp" }] };

beforeEach(() => {
  generateObject.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("analyzePdfText fallback marker", () => {
  test("double failure returns the marked fallback snapshot with no telemetry", async () => {
    generateObject.mockRejectedValue(new Error("model down"));
    const out = await analyzePdfText(input);
    expect(out).not.toBeNull();
    expect(isFallbackAnalysis(out)).toBe(true);
    expect(analysisTelemetry(out)).toBeNull();
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  test("a successful run is not marked and carries provider usage in ledger shape", async () => {
    generateObject.mockResolvedValue({
      object: { summary: "A seed deck.", doc_name: "Acme Corp Pitch Deck", tags: ["seed"] },
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    });
    const out = await analyzePdfText(input);
    expect(isFallbackAnalysis(out)).toBe(false);
    const t = analysisTelemetry(out);
    expect(t).toMatchObject({ provider: "openai", promptTokens: 1200, completionTokens: 300, totalTokens: 1500, retriesCount: 0 });
    expect(typeof t?.modelRoute).toBe("string");
  });

  test("a retry that succeeds records retriesCount 1", async () => {
    generateObject.mockRejectedValueOnce(new Error("truncated")).mockResolvedValueOnce({
      object: { summary: "ok" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const out = await analyzePdfText(input);
    expect(isFallbackAnalysis(out)).toBe(false);
    expect(analysisTelemetry(out)?.retriesCount).toBe(1);
  });

  test("the marker is not a property of the snapshot (nothing to persist)", async () => {
    generateObject.mockRejectedValue(new Error("model down"));
    const out = await analyzePdfText(input);
    expect(JSON.stringify(out)).not.toContain("fallback");
    expect(isFallbackAnalysis(JSON.parse(JSON.stringify(out)))).toBe(false);
  });
});
