/**
 * AI outcome warnings for a finished upload (`upload.ai` from `GET /api/uploads/:id`).
 *
 * A skipped or failed AI step never invalidates the share link, so tools report it as a warning
 * string the agent can relay, never as an error.
 */
import type { ApiClient, UploadAi } from "../api";

const FREE_SHARE_HINT = "Pass summary and keyPoints to share without credits.";

/** Why an AI step did not run, phrased for the agent. */
function because(ai: UploadAi, step: "summary" | "compare"): string {
  const needs = ai.creditsNeeded !== null ? ` (needs ${ai.creditsNeeded})` : "";
  switch (ai.code) {
    case "out_of_credits":
      return `out of AI credits${needs}.${step === "summary" ? ` ${FREE_SHARE_HINT}` : ""}`;
    case "daily_cap":
      return `daily credit cap reached${needs}.${step === "summary" ? ` ${FREE_SHARE_HINT}` : ""}`;
    case "plan":
      // No longer emitted since 2026-09-13 (compare is credit-gated on every plan); kept for old uploads.
      return "not included on this plan.";
    case "recipient":
      return "uploads through a request link are not summarized.";
    default:
      return ai.reason ? `${ai.reason}.` : "an error occurred.";
  }
}

/** Warning strings for `ai` (empty when every step ran or did not apply). */
export function warningsFromAi(ai: UploadAi | null): string[] {
  if (!ai) return [];
  const out: string[] = [];
  if (ai.summary === "skipped") out.push(`AI summary skipped: ${because(ai, "summary")}`);
  if (ai.summary === "failed") out.push(`AI summary failed: ${because(ai, "summary")} The share link still works.`);
  if (ai.compare === "skipped") out.push(`AI compare skipped: ${because(ai, "compare")}`);
  if (ai.compare === "failed") out.push(`AI compare failed: ${because(ai, "compare")}`);
  return out;
}

/**
 * Read the upload's AI outcome (and, when asked, the credits snapshot) without ever throwing:
 * unreadable data just means no warnings and no `creditsRemaining`.
 */
export async function readAiOutcome(
  api: ApiClient,
  uploadId: string | null,
  opts: { credits?: boolean } = {},
): Promise<{ warnings: string[]; creditsRemaining: number | null; ai: UploadAi | null }> {
  const [upload, credits] = await Promise.all([
    uploadId ? api.getUpload(uploadId).catch(() => null) : Promise.resolve(null),
    opts.credits ? api.creditsSnapshot().catch(() => null) : Promise.resolve(null),
  ]);
  const ai = upload?.ai ?? null;
  return { warnings: warningsFromAi(ai), creditsRemaining: credits?.creditsRemaining ?? null, ai };
}
