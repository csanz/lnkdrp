/**
 * Agent-written summaries.
 *
 * An agent that uploads a PDF over MCP (or the API) has usually read the document already, so it
 * can supply the summary and key points itself. Those uploads skip our AI summary and cost 0
 * credits. The input is untrusted text that ends up on a public share page, so it is cleaned
 * (URLs and markup removed, whitespace collapsed) and bounded; anything below the minimum is
 * rejected with a clear message rather than silently falling back to our model.
 */
import { normalizeAiDocAnalysis, type AiDocAnalysis } from "@/lib/ai/analyzePdfText";

export const AGENT_SUMMARY_MIN_CHARS = 40;
export const AGENT_SUMMARY_MAX_CHARS = 600;
export const AGENT_KEY_POINTS_MIN = 2;
export const AGENT_KEY_POINTS_MAX = 7;
export const AGENT_KEY_POINT_MAX_CHARS = 160;
export const INVALID_SUMMARY_CODE = "invalid_summary";

/** A validated agent summary as stored on the upload (`Upload.agentSummary`). */
export type AgentSummary = {
  summary: string;
  keyPoints: string[];
  /** Client id of the agent that wrote it (e.g. `claude-code`), when known. */
  client: string | null;
  /** Display label of that client (e.g. `Claude Code`), when known. */
  label: string | null;
};

/** Remove URLs, HTML tags and Markdown syntax, then collapse whitespace. */
export function cleanAgentText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/[*_`#>~|]+/g, " ")
    .replace(/^\s*[-+•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type ParsedAgentSummary =
  | { ok: true; value: { summary: string; keyPoints: string[] } | null }
  | { ok: false; error: string };

/**
 * Validate untrusted `summary` + `keyPoints` from a request body.
 * Neither present → `{ ok: true, value: null }` (no agent summary). One without the other, or
 * values outside the bounds after cleaning → `{ ok: false, error }` with a message the agent can act on.
 */
export function parseAgentSummaryInput(input: { summary?: unknown; keyPoints?: unknown }): ParsedAgentSummary {
  const hasSummary = input.summary !== undefined && input.summary !== null && input.summary !== "";
  const hasPoints = input.keyPoints !== undefined && input.keyPoints !== null;
  if (!hasSummary && !hasPoints) return { ok: true, value: null };
  if (!hasSummary || !hasPoints) {
    return { ok: false, error: "Pass both summary and keyPoints, or neither." };
  }
  if (typeof input.summary !== "string") return { ok: false, error: "summary must be a string." };
  if (!Array.isArray(input.keyPoints)) return { ok: false, error: "keyPoints must be an array of strings." };

  const summary = cleanAgentText(input.summary);
  if (summary.length < AGENT_SUMMARY_MIN_CHARS) {
    return { ok: false, error: `summary must be at least ${AGENT_SUMMARY_MIN_CHARS} characters of plain text (URLs and markup are removed).` };
  }
  if (summary.length > AGENT_SUMMARY_MAX_CHARS) {
    return { ok: false, error: `summary must be at most ${AGENT_SUMMARY_MAX_CHARS} characters.` };
  }

  const keyPoints: string[] = [];
  for (const raw of input.keyPoints) {
    if (typeof raw !== "string") return { ok: false, error: "keyPoints must be an array of strings." };
    const point = cleanAgentText(raw);
    if (!point) continue;
    if (point.length > AGENT_KEY_POINT_MAX_CHARS) {
      return { ok: false, error: `Each key point must be at most ${AGENT_KEY_POINT_MAX_CHARS} characters.` };
    }
    keyPoints.push(point);
  }
  if (keyPoints.length < AGENT_KEY_POINTS_MIN || keyPoints.length > AGENT_KEY_POINTS_MAX) {
    return { ok: false, error: `Pass ${AGENT_KEY_POINTS_MIN} to ${AGENT_KEY_POINTS_MAX} non-empty key points.` };
  }
  return { ok: true, value: { summary, keyPoints } };
}

/** Read a stored `Upload.agentSummary` back defensively; null when absent or malformed. */
export function readStoredAgentSummary(raw: unknown): AgentSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const parsed = parseAgentSummaryInput({ summary: r.summary, keyPoints: r.keyPoints });
  if (!parsed.ok || !parsed.value) return null;
  return {
    ...parsed.value,
    client: typeof r.client === "string" && r.client.trim() ? r.client.trim() : null,
    label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : null,
  };
}

/** First sentence of the summary, bounded, for the one-liner slot. */
function firstSentence(text: string): string {
  const m = text.match(/^(.{20,220}?[.!?])(\s|$)/);
  const s = (m ? m[1] : text).trim();
  return s.length > 220 ? `${s.slice(0, 217).trimEnd()}…` : s;
}

/**
 * Build the stored AI analysis from an agent summary: the summary, one-liner and key points fill the
 * fields the doc page and share page render; everything else takes the normalizer's defaults and
 * the processing job's text-derived fallbacks.
 */
export function agentSummaryToAnalysis(
  agent: AgentSummary,
  pages?: Array<{ page_number: number; text: string }>,
): AiDocAnalysis & { summary_by: { kind: "agent"; client: string | null; label: string | null } } {
  const base = normalizeAiDocAnalysis(
    {
      summary: agent.summary,
      one_liner: firstSentence(agent.summary),
      solution_summary: agent.summary,
      primary_capabilities_or_scope: agent.keyPoints,
      meta_description: firstSentence(agent.summary),
    },
    pages,
  );
  return { ...base, summary_by: { kind: "agent", client: agent.client, label: agent.label } };
}
