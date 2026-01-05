import type { ActionType, QualityTier } from "@/lib/credits/types";

/**
 * Fixed per-run credit schedule for this iteration.
 *
 * IMPORTANT:
 * - This is only used because the repo snapshot does not contain a persisted "true cost" field.
 * - Keep this small and explicit so we can later swap reconciliation to use true cost without
 *   schema changes.
 */
export function creditsForRun(params: { actionType: ActionType; qualityTier: QualityTier }): number {
  const a = params.actionType;
  const q = params.qualityTier;

  // summary (default automatic = Basic)
  if (a === "summary") {
    if (q === "basic") return 1;
    if (q === "standard") return 2;
    return 5; // advanced
  }

  // review (user-initiated)
  if (a === "review") {
    if (q === "basic") return 2;
    if (q === "advanced") return 12;
    return 5; // standard (default)
  }

  // history (replacement compare or user-initiated)
  if (a === "history") {
    if (q === "basic") return 2;
    if (q === "advanced") return 12;
    return 5; // standard (default)
  }

  return 0;
}


