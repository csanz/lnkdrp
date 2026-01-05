/**
 * Billing pricing constants.
 *
 * IMPORTANT:
 * - These constants are used for enforcing caps and converting limits (credits-first UX).
 * - Do not use these to fabricate invoice dollars when Stripe-backed costs are unavailable.
 */

/** Canonical conversion used for on-demand spend limits: $0.10 per credit. */
export const USD_CENTS_PER_CREDIT = 10;


