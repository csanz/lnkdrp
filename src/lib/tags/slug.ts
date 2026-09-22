/**
 * How a tag name folds to the key that decides whether two tags are the same tag.
 *
 * Client-safe (no database imports) so the input's "this tag already exists" hint and the server's
 * uniqueness check fold identically — a mismatch there is how a workspace ends up with
 * "Fundraising" and "fundraising" side by side, which is the failure mode tags are most prone to.
 *
 * Shaped like the project slug (`src/app/api/projects/route.ts`): trim, strip accents to their base
 * letter, lower case, collapse anything else to a single dash. It keeps letters in every script
 * rather than ASCII alone, because the two slugs answer an empty fold differently: a project falls
 * back to "project" and is created anyway, while a tag with no slug is refused outright, so an
 * ASCII-only class here means a workspace that writes in Cyrillic or Japanese cannot file at all.
 */

/** Longest name a tag may carry; the folded form is bounded by the same number. */
export const TAG_NAME_MAX = 60;

/** `"  Série A "` → `"serie-a"`. Returns `""` for a name with nothing matchable in it. */
export function tagSlug(input: string): string {
  return (
    input
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      // NFKD leaves ß alone, so without this "Straße" kept the ß, lost it to the separator class
      // and filed as "stra-e" while "Strasse" filed as "strasse": one word, two tags.
      .replace(/ß/g, "ss")
      .replace(/['"]/g, "")
      // Letters, digits and combining marks in any script, not just ASCII. The old `[^a-z0-9]+`
      // deleted every Cyrillic, CJK, Greek, Arabic and Hebrew letter, so the fold came back empty
      // and every caller answered "A tag needs at least one letter or number" to a field holding
      // eleven letters. Marks stay because outside Latin they carry the word: Devanagari matras and
      // Hebrew niqqud are marks, and dashing them out would merge unrelated names into one tag.
      // (The accent strip above still runs first, so é and e fold together in every script alike.)
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
      // Cap before stripping dangling dashes, never after. NFKD expands compatibility characters,
      // so a name inside the 60-character limit can fold longer than 60 (each ﬁ becomes "fi"), and
      // cutting a stripped slug back to 60 could re-expose a separator at the end. That slug is not
      // what the fold produces from itself, and /api/tags/by-slug re-folds the segment it is given,
      // so the tag's own page answered "may have been renamed or removed" for a tag that exists.
      .slice(0, TAG_NAME_MAX)
      // The cut can also land between the halves of an astral letter (Deseret, CJK extensions).
      // A lone surrogate is not a letter to the class above, so leaving it in would break the same
      // round trip a dangling dash does.
      .replace(/[\uD800-\uDBFF]$/, "")
      .replace(/^-+|-+$/g, "")
  );
}

/** The display name as stored: whitespace collapsed, length bounded, case left as typed. */
export function normalizeTagName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, TAG_NAME_MAX);
}

/** Whether a typed name can become a tag at all (something survives folding). */
export function isUsableTagName(input: string): boolean {
  return tagSlug(input).length > 0;
}
