/**
 * Shared number formatting helpers (UI-safe).
 *
 * NOTE: Keep behavior consistent with existing dashboard UI helpers:
 * - Accept numbers and numeric strings (unknown input).
 * - Clamp to a non-negative integer.
 * - Locale formatting uses `toLocaleString()` with a safe fallback.
 */
export function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

export function formatInt(n: unknown): string {
  const v = clampNonNegInt(n);
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}


