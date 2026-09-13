import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/ai/aiRunRecorder", () => ({ startAiRun: vi.fn(), completeAiRun: vi.fn(), failAiRun: vi.fn() }));

import { agentSummaryToAnalysis, cleanAgentText, parseAgentSummaryInput, readStoredAgentSummary } from "@/lib/ai/agentSummary";

const summary = "Acme builds payroll software for small clinics and is raising a $2M seed round to expand sales.";

describe("agent summary input", () => {
  test("neither field means no agent summary", () => {
    expect(parseAgentSummaryInput({})).toEqual({ ok: true, value: null });
  });

  test("one without the other is rejected", () => {
    expect(parseAgentSummaryInput({ summary }).ok).toBe(false);
    expect(parseAgentSummaryInput({ keyPoints: ["a", "b"] }).ok).toBe(false);
  });

  test("URLs and markup are stripped before the length check", () => {
    expect(cleanAgentText("**Bold** [site](https://x.com) <b>hi</b> see https://evil.example/path")).toBe("Bold site hi see");
    const out = parseAgentSummaryInput({ summary: "https://a.com https://b.com <i>short</i>", keyPoints: ["one", "two"] });
    expect(out.ok).toBe(false);
  });

  test("bounds: summary 40-600, 2-7 key points each at most 160", () => {
    expect(parseAgentSummaryInput({ summary: "x".repeat(601), keyPoints: ["a", "b"] }).ok).toBe(false);
    expect(parseAgentSummaryInput({ summary, keyPoints: ["only one"] }).ok).toBe(false);
    expect(parseAgentSummaryInput({ summary, keyPoints: Array.from({ length: 8 }, (_, i) => `p${i}`) }).ok).toBe(false);
    expect(parseAgentSummaryInput({ summary, keyPoints: ["a", "y".repeat(161)] }).ok).toBe(false);
    const ok = parseAgentSummaryInput({ summary, keyPoints: ["- Seed round of $2M", "* 40 clinics live", "  "] });
    expect(ok).toEqual({ ok: true, value: { summary, keyPoints: ["Seed round of $2M", "40 clinics live"] } });
  });

  test("stored values are re-validated and carry attribution", () => {
    expect(readStoredAgentSummary({ summary: "too short", keyPoints: ["a", "b"] })).toBeNull();
    const stored = readStoredAgentSummary({ summary, keyPoints: ["a1", "b2"], client: "claude-code", label: "Claude Code" });
    expect(stored?.client).toBe("claude-code");
    const analysis = agentSummaryToAnalysis(stored!);
    expect(analysis.summary).toBe(summary);
    expect(analysis.primary_capabilities_or_scope).toEqual(["a1", "b2"]);
    expect(analysis.one_liner.endsWith(".")).toBe(true);
    expect(analysis.summary_by).toEqual({ kind: "agent", client: "claude-code", label: "Claude Code" });
  });
});
