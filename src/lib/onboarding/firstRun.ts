/**
 * Whether this account has been through first-run setup, and how it gets stamped.
 *
 * One screen, once, on the way in: the three answers that are wrong by default for somebody new
 * (their name, what their workspace is called, and whether they hear about an open immediately or
 * tomorrow), and then out of the way for ever.
 *
 * **Nobody who already has an account sees it.** That is the whole difficulty. A flag that means
 * "not yet onboarded" is missing on every existing row too, so reading it naively would send the
 * entire user base through a welcome screen they do not need — after they have already named
 * things and chosen their preferences. The cutoff below is what separates the two populations
 * without a migration: an account created before first-run existed was never offered it, so it
 * counts as done. A one-time backfill job would have worked as well and is one more thing for an
 * operator to remember and to get wrong; a constant cannot drift from the code that reads it.
 *
 * The flag lives in `User.metadata`, which is `Mixed` and already holds `activeOrgId`. It is a
 * timestamp rather than a boolean because "when did they set up" answers questions later that
 * "true" cannot.
 */
import { Types } from "mongoose";

import { UserModel } from "@/lib/models/User";

/**
 * Accounts created before this instant are treated as already set up.
 *
 * The moment first-run shipped. Do not move it forward later to "re-onboard" anyone: it would
 * catch every account created in between, including people who did see the screen.
 */
export const FIRST_RUN_SINCE = new Date("2026-09-20T00:00:00.000Z");

export const FIRST_RUN_PATH = "/welcome";

/** What `metadata` holds once the screen has been finished or skipped. */
export type FirstRunState = { onboardedAt: Date | null; createdAt: Date | null };

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * The decision, from a row that has already been read.
 *
 * Pure, so the rule can be tested without Mongo and so the layout and the page cannot disagree
 * about what "needs setup" means.
 */
export function needsFirstRun(state: FirstRunState): boolean {
  if (state.onboardedAt) return false;
  // No creation date at all is the unknown case, and the safe answer there is "leave them alone":
  // an unwanted welcome screen in front of an established workspace is worse than a missed one.
  if (!state.createdAt) return false;
  return state.createdAt.getTime() >= FIRST_RUN_SINCE.getTime();
}

/** Read the two fields the decision needs. Returns `false` for anything it cannot resolve. */
export async function userNeedsFirstRun(userId: string): Promise<boolean> {
  if (!userId || !Types.ObjectId.isValid(userId)) return false;
  try {
    const u = (await UserModel.findById(userId).select({ createdAt: 1, "metadata.onboardedAt": 1 }).lean()) as
      | { createdAt?: unknown; metadata?: { onboardedAt?: unknown } }
      | null;
    if (!u) return false;
    return needsFirstRun({
      onboardedAt: asDate(u.metadata?.onboardedAt),
      createdAt: asDate(u.createdAt),
    });
  } catch {
    // A database blip must not put a welcome screen in front of someone mid-task.
    return false;
  }
}

/**
 * Mark it done. Called when the screen is finished *and* when it is skipped.
 *
 * Skipping counts on purpose: the alternative is a screen that reappears on every navigation until
 * it gets its way, which is not a setup step, it is a nag.
 */
export async function markFirstRunDone(userId: string): Promise<void> {
  if (!userId || !Types.ObjectId.isValid(userId)) return;
  await UserModel.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { "metadata.onboardedAt": new Date() } });
}
