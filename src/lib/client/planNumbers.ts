/**
 * The plan numbers, spelled once for every client surface.
 *
 * `src/lib/billing/planLimits.ts` and `src/lib/credits/grants.ts` are the authority, but both import
 * Mongoose models, so nothing in a client bundle can read them. These constants are the mirror the
 * pricing card, the upgrade modal, Terms, the billing tab and the login page all read instead.
 *
 * `tests/lib/planCopyMirror.test.ts` asserts every value here equals its server counterpart. That
 * test exists because the mirror went stale exactly once and silently: raising the Free grant to 100
 * credits and the document cap to 10 left the screens promising 50 and 3, with nothing failing.
 * Change a number on the server and this file fails until it agrees.
 *
 * It lives apart from `planLimit.ts` because `planLimit.ts` and `upsellCopy.ts` already import each
 * other, and both need these numbers — putting them in either one makes that a runtime cycle. This
 * module imports nothing, so anything may read it.
 */

/** Free-plan caps, mirrored from `src/lib/billing/planLimits.ts`. */
export const FREE_PLAN_LIMITS_COPY = {
  documents: 10,
  projects: 2,
  analyticsDays: 7,
} as const;

/** Credit numbers, mirrored from `src/lib/credits/grants.ts` and `src/lib/credits/creditService.ts`. */
export const CREDITS_COPY = {
  /** One-time starter grant for Free workspaces (no cycle reset). */
  freeStarter: 100,
  /** Included credits per billing cycle on Pro. */
  proPerMonth: 500,
  /** Free daily brake (`FREE_DAILY_CREDIT_CAP` in `src/lib/credits/creditService.ts`). */
  freeDailyCap: 15,
  /** Pay-as-you-go price per credit (`USD_CENTS_PER_CREDIT`), for a Free workspace with a card on file or Pro on-demand. */
  perCreditUsd: "$0.10",
  /** "No card needed" family, since Free asks for one only once the starter grant runs out. */
  noCardToStart: "No card needed to start.",
} as const;

/**
 * Roughly how many AI compares an allowance buys, at the credit prices in
 * `src/lib/credits/schedule.ts` (basic 2, standard 5, advanced 12).
 *
 * Every "about 60 standard compares" in the copy used to be written out by hand beside the credit
 * number it was derived from, so raising the allowance left the two disagreeing on the same line.
 */
export const COMPARE_CREDITS = { basic: 2, standard: 5, advanced: 12 } as const;

/** "about N standard compares" for a credit allowance. */
export function comparesFor(credits: number, tier: keyof typeof COMPARE_CREDITS = "standard"): number {
  return Math.floor(credits / COMPARE_CREDITS[tier]);
}
