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
  // "unchanged": the upload was the same file, so the previous version's summary was kept. Nothing
  // was skipped for a reason the human needs to hear.
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
): Promise<{
  warnings: string[];
  creditsRemaining: number | null;
  ai: UploadAi | null;
  failureReason: string | null;
  unchangedFromPrevious: boolean;
}> {
  const [upload, credits] = await Promise.all([
    uploadId ? api.getUpload(uploadId).catch(() => null) : Promise.resolve(null),
    opts.credits ? api.creditsSnapshot().catch(() => null) : Promise.resolve(null),
  ]);
  const ai = upload?.ai ?? null;
  // A processing failure is not an AI warning: the file itself is unusable, and an agent that only
  // sees status "failed" with an empty warnings array cannot tell the human anything actionable.
  const failureReason = upload?.status === "failed" ? (upload.error ?? "processing failed; the file could not be read") : null;
  const warnings = warningsFromAi(ai);
  if (failureReason) {
    warnings.unshift(
      `This version failed to process: ${failureReason}. Its link is live but has no usable file - upload a working PDF with lnkdrp_replace_pdf, or delete the document.`,
    );
  }
  // Carried beside the AI state, never folded into it: the compare against the previous version is
  // what decides this, and ai.summary only happens to echo it when lnkdrp wrote the summary itself.
  // `ai.summary === "unchanged"` is kept as a fallback for rows whose best-effort flag write lost.
  const unchangedFromPrevious = upload?.unchangedFromPrevious === true || ai?.summary === "unchanged";
  return { warnings, creditsRemaining: credits?.creditsRemaining ?? null, ai, failureReason, unchangedFromPrevious };
}
