import type { ActionType, QualityTier } from "@/lib/credits/types";

/**
 * Fixed per-run credit schedule for this iteration.
 *
 * IMPORTANT:
 * - This is only used because the repo snapshot does not contain a persisted "true cost" field.
 * - Keep this small and explicit so we can later swap reconciliation to use true cost without
 *   schema changes.
 */
/**
 * Actions included on every plan. Empty since 2026-09-13: before that date the automatic summary was
 * included; from 2026-09-13 the founder decided it is a real cost and it deducts credits, 1/2/5 by
 * tier (AI compare 2/5/12; AI review not released). Agent-written summaries and recipient uploads
 * cost the owner 0 credits through separate paths (no lnkdrp run, or a 0-credit recipient ledger
 * row in creditService.ts), not through this set.
 * Add an action here to make it free without touching the tier prices below.
 * The ledger still records a 0-credit row for included actions so usage stays visible.
 * Remove an action from this set to start charging the tier prices below again.
 */
export const INCLUDED_ACTIONS_AT_LAUNCH: ReadonlySet<ActionType> = new Set<ActionType>([]);

export function creditsForRun(params: { actionType: ActionType; qualityTier: QualityTier }): number {
  const a = params.actionType;
  const q = params.qualityTier;

  if (INCLUDED_ACTIONS_AT_LAUNCH.has(a)) return 0;

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


