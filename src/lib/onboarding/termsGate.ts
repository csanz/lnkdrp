/**
 * Whether this account still owes us an acceptance of the Terms.
 *
 * The invitation flow sends people to `/accept`, but nothing made them go: an account approved by
 * `npm run waitlist:invite` (or by the admin Approve button) is out of the queue the moment it is
 * approved, so anyone who ignored the email simply signed in and used the product. The record said
 * "never accepted" and the app did not care.
 *
 * This is the half that cares. It has the same shape as `firstRun.ts`, for the same reason and with
 * the same trap: **`termsAcceptedAt` is null on every account that predates the field**, so reading
 * it naively would put an agreement screen in front of the entire existing user base — people who
 * signed up under Terms they accepted at sign-up, now told they had not. The cutoff separates the
 * two populations without a migration.
 *
 * Deliberately *not* keyed on `CURRENT_TERMS_VERSION`. Bumping that constant is how a later change
 * is described; re-prompting everybody is a product decision with a date attached, and it should
 * take an edit here rather than happening the moment somebody corrects a typo in the Terms.
 */
import { Types } from "mongoose";

import { UserModel } from "@/lib/models/User";

/**
 * Accounts created before this instant are treated as having accepted.
 *
 * The moment the accept flow shipped. Do not move it forward later to re-prompt anyone: it would
 * catch every account created in between, including the people who did accept.
 */
export const TERMS_GATE_SINCE = new Date("2026-09-21T00:00:00.000Z");

export const TERMS_ACCEPT_PATH = "/accept";

export type TermsState = { termsAcceptedAt: Date | null; createdAt: Date | null };

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * The decision, from a row already read.
 *
 * Pure, so the gate and the page cannot disagree about who still owes an acceptance.
 */
export function needsTermsAcceptance(state: TermsState): boolean {
  if (state.termsAcceptedAt) return false;
  // No creation date is the unknown case, and the safe answer is to leave them alone: an agreement
  // screen in front of an established account is worse than a missed one.
  if (!state.createdAt) return false;
  return state.createdAt.getTime() >= TERMS_GATE_SINCE.getTime();
}

/** Read the two fields the decision needs. `false` for anything it cannot resolve. */
export async function userNeedsTermsAcceptance(userId: string): Promise<boolean> {
  if (!userId || !Types.ObjectId.isValid(userId)) return false;
  try {
    const u = (await UserModel.findById(userId).select({ createdAt: 1, termsAcceptedAt: 1 }).lean()) as
      | { createdAt?: unknown; termsAcceptedAt?: unknown }
      | null;
    if (!u) return false;
    return needsTermsAcceptance({
      termsAcceptedAt: asDate(u.termsAcceptedAt),
      createdAt: asDate(u.createdAt),
    });
  } catch {
    // A database blip must not lock somebody out of their own workspace mid-task.
    return false;
  }
}
