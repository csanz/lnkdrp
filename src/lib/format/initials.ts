/**
 * Return a short uppercase initials string for a display name or email.
 *
 * - Blank input returns "?"
 * - Single "word" returns first 2 characters
 * - Multi-word returns first char of first and last words
 */
export function initialsFromNameOrEmail(nameOrEmail: string): string {
  const s = String(nameOrEmail ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

