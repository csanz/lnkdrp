/**
 * Pipeline status → admin tone.
 *
 * Docs and uploads share one status vocabulary (a document's status is the status of the
 * upload behind it), and two pages were colouring it by hand in slightly different ways.
 * The mapping lives here so `ready` is the same quiet grey on both pages and `failed` is
 * the only row that shouts.
 *
 * `ready` is deliberately `quiet`: it is the normal, uninteresting outcome, and a column
 * that is 95% green is decoration rather than information.
 */

import type { AdminTone } from "@/lib/admin/ui";

/** Tone for a doc/upload processing status. Unknown values stay neutral rather than guessing. */
export function pipelineStatusTone(status: string | null | undefined): AdminTone {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "neutral";
  if (s === "failed" || s === "error") return "danger";
  if (s === "preparing" || s === "processing" || s === "queued" || s === "pending") return "warning";
  if (s === "ready" || s === "complete" || s === "completed") return "quiet";
  if (s === "draft") return "neutral";
  return "neutral";
}
