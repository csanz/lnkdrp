/**
 * Tiny className join helper (no dependency).
 *
 * Prefer this over ad-hoc `clsx()` helpers sprinkled in components.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}


