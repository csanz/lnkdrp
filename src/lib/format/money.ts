/**
 * Shared money formatting helpers (UI-safe).
 *
 * IMPORTANT: Keep behavior consistent with existing dashboard UI helpers:
 * - Treat cents as a non-negative integer (floor + clamp).
 * - Format as USD using the runtime locale.
 * - Use "Not available" exactly (do not change the string).
 */

import { clampNonNegInt } from "@/lib/format/number";

/**
 * Formats a cents amount as a USD currency string.
 *
 * Exists to keep billing UI formatting consistent and resilient to bad inputs.
 * Assumptions: cents are treated as non-negative; decimals are always shown.
 */
export function formatUsdFromCents(cents: number): string {
  const dollars = clampNonNegInt(cents) / 100;
  try {
    // Keep this consistent with existing billing UI: always show 2 decimals.
    return dollars.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  } catch {
    return `$${dollars.toFixed(2)}`;
  }
}

/**
 * Formats a cents amount as USD, or returns the exact string "Not available".
 *
 * Exists for billing tables where cost can be unknown (missing telemetry) but still needs a stable label.
 */
export function formatUsdOrNotAvailable(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "Not available";
  return formatUsdFromCents(cents);
}



/**
 * Formats a US dollar amount that may be a fraction of a cent.
 *
 * Exists because our own AI cost does not fit the invoice formatter above. One text summary costs
 * about $0.0004 and `formatUsdFromCents` would print every one of them as "$0.00", which reads as
 * free and is the exact impression the cost tracking exists to remove. Four decimals below a
 * dollar, two above it, where the fourth decimal stops carrying information.
 *
 * Null is "Not recorded" and never "$0.00": a run whose model is not in the price table, or whose
 * provider reported no usage, cost something we cannot state.
 */
export function formatUsdCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "Not recorded";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

/**
 * Formats a ratio as a whole-number percentage, or a dash placeholder when there is no ratio.
 *
 * Exists so a margin column reads "62%" rather than "0.6231", and so the "no answer yet" case (a
 * window in which nothing was charged, or nothing could be priced) is one shared string instead of
 * a per-caller improvisation.
 */
export function formatRatioPct(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "–";
  return `${Math.round(ratio * 100)}%`;
}
