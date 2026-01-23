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


