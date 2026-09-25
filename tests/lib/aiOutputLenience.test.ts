/**
 * Model output is clipped or stripped, never refused for shape trivia (code review 2026-09-23,
 * Low: MCP/AI): a compare with an over-long summary is kept and clipped, and a review with an
 * extra field the prompt did not ask for keeps its nine fields.
 */
import { describe, expect, it } from "vitest";

import { DocChangeDiffSchema, shapeDiff } from "@/lib/ai/docChangeDiff";
import { RequestReviewInvestorFocusedSchema } from "@/lib/ai/requestReviewInvestorFocused";

describe("docChangeDiff: long answers are clipped, not rejected", () => {
  it("parses an over-long summary and shapeDiff clips it", () => {
    const parsed = DocChangeDiffSchema.parse({
      summary: "x".repeat(10_000),
      changes: [{ type: "text", title: "t".repeat(5_000), detail: null }],
      pagesThatChanged: Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, summary: "s".repeat(3_000) })),
    });
    const shaped = shapeDiff(parsed);
    expect(shaped.summary.length).toBeLessThan(10_000);
    expect(shaped.pagesThatChanged.length).toBeLessThanOrEqual(30);
    expect(shaped.pagesThatChanged[0].summary.length).toBeLessThan(3_000);
  });
});

describe("requestReviewInvestorFocused: unknown keys are stripped", () => {
  const base = {
    stage_match: true,
    notes: "n",
    relevancy: "high",
    relevancy_reason: "r",
    strengths: ["a"],
    weaknesses: [],
    key_open_questions: [],
    summary_markdown: "# s",
    founder_note: "f",
  };

  it("keeps the nine fields and drops an extra one", () => {
    const out = RequestReviewInvestorFocusedSchema.parse({ ...base, confidence: 0.9 });
    expect(out).toEqual(base);
    expect("confidence" in out).toBe(false);
  });

  it("still refuses a missing or mistyped required field", () => {
    expect(() => RequestReviewInvestorFocusedSchema.parse({ ...base, relevancy: "huge" })).toThrow();
    const { founder_note: _dropped, ...missing } = base;
    void _dropped;
    expect(() => RequestReviewInvestorFocusedSchema.parse(missing)).toThrow();
  });
});
