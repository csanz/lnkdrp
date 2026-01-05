/**
 * Hard-coded spend limits (cents) for the current billing period.
 *
 * Cursor-style presets:
 * - $50, $100, $200, $500, Unlimited, Custom
 *
 * Notes:
 * - We represent "Unlimited" as a very large hard limit so the app can still enforce
 *   a cap without special-casing "no limit" server-side.
 * - `DEFAULT_LIMIT=0` means "on-demand usage disabled" (hard block).
 */

export const UNLIMITED_LIMIT_CENTS = 1_000_000_00; // $1,000,000.00 (effectively unlimited for now)

export const ALLOWED_LIMITS = [0, 5_000, 10_000, 20_000, 50_000, UNLIMITED_LIMIT_CENTS] as const;

export const DEFAULT_LIMIT = 0;


