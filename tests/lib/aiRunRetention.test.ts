/**
 * AI run rows are bounded and expire (code review 2026-09-23, Low: MCP/AI): prompts are clipped
 * to `AI_RUN_PROMPT_MAX_CHARS` at write time and the model declares a TTL index on `createdDate`.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (doc: unknown) => ({ _id: "id", doc })),
  realIndexes: null as null | Array<[Record<string, unknown>, Record<string, unknown>]>,
}));
vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => undefined }));
vi.mock("@/lib/models/AiRun", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/models/AiRun")>();
  mocks.realIndexes = real.AiRunModel.schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown>]>;
  return { ...real, AiRunModel: { create: mocks.create } };
});

import { AI_RUN_PROMPT_MAX_CHARS, startAiRun } from "@/lib/ai/aiRunRecorder";
import { AI_RUN_RETENTION_DAYS } from "@/lib/models/AiRun";

describe("AiRun retention", () => {
  it("clips a long user prompt to the bound, keeping head and tail", async () => {
    const long = "H".repeat(60_000) + "T".repeat(60_000);
    await startAiRun({
      kind: "visitBrief",
      provider: "openai",
      model: null,
      temperature: null,
      maxRetries: null,
      systemPrompt: "sys",
      userPrompt: long,
      inputTextChars: long.length,
    });
    const written = (mocks.create.mock.calls as unknown[][])[0][0] as { userPrompt: string };
    expect(written.userPrompt.length).toBeLessThan(AI_RUN_PROMPT_MAX_CHARS + 100);
    expect(written.userPrompt.startsWith("HHHH")).toBe(true);
    expect(written.userPrompt.endsWith("TTTT")).toBe(true);
    expect(written.userPrompt).toContain("[truncated]");
  });

  it("declares a TTL index on createdDate matching the retention setting", () => {
    expect(AI_RUN_RETENTION_DAYS).toBeGreaterThan(0);
    const ttl = (mocks.realIndexes ?? []).find(([key]) => JSON.stringify(key) === JSON.stringify({ createdDate: 1 }));
    expect(ttl).toBeDefined();
    expect(ttl?.[1].expireAfterSeconds).toBe(AI_RUN_RETENTION_DAYS * 24 * 60 * 60);
  });
});
