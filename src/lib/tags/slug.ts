/**
 * How a tag name folds to the key that decides whether two tags are the same tag.
 *
 * Client-safe (no database imports) so the input's "this tag already exists" hint and the server's
 * uniqueness check fold identically — a mismatch there is how a workspace ends up with
 * "Fundraising" and "fundraising" side by side, which is the failure mode tags are most prone to.
 *
 * Same folding the project slug already uses (`src/app/api/projects/route.ts`): trim, strip accents
 * to their base letter, lower case, collapse anything else to a single dash.
 */

/** Longest name a tag may carry; the folded form is bounded by the same number. */
export const TAG_NAME_MAX = 60;

/** `"  Série A "` → `"serie-a"`. Returns `""` for a name with nothing matchable in it. */
export function tagSlug(input: string): string {
  return input
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TAG_NAME_MAX);
}

/** The display name as stored: whitespace collapsed, length bounded, case left as typed. */
export function normalizeTagName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, TAG_NAME_MAX);
}

/** Whether a typed name can become a tag at all (something survives folding). */
export function isUsableTagName(input: string): boolean {
  return tagSlug(input).length > 0;
}
