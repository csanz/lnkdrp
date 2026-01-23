/**
 * Shared number formatting helpers (UI-safe).
 *
 * NOTE: Keep behavior consistent with existing dashboard UI helpers:
 * - Accept numbers and numeric strings (unknown input).
 * - Clamp to a non-negative integer.
 * - Locale formatting uses `toLocaleString()` with a safe fallback.
 */
/**
 * Coerces an unknown value into a non-negative integer.
 *
 * Exists to accept numeric strings and keep UI formatting predictable and safe.
 */
export function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

/**
 * Formats an unknown numeric input as a locale-formatted integer string.
 *
 * Invalid inputs format as "0" (after clamping).
 */
export function formatInt(n: unknown): string {
  const v = clampNonNegInt(n);
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}


