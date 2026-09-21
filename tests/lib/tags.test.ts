/**
 * The rules that decide whether two tags are the same tag, and which colour a new one gets.
 *
 * These are the parts that rot a tag list quietly: a fold that disagrees between the input's
 * "already exists" hint and the server's uniqueness check produces "Fundraising" and "fundraising"
 * side by side, and a colour picker that does not spread produces five tags in one colour.
 */
import { describe, expect, test } from "vitest";

import { TAG_COLOR_KEYS, asTagColorKey, nextTagColor, DEFAULT_TAG_COLOR } from "@/lib/tags/palette";
import { TAG_NAME_MAX, isUsableTagName, normalizeTagName, tagSlug } from "@/lib/tags/slug";

describe("tags/slug", () => {
  test("case and surrounding space do not make a second tag", () => {
    expect(tagSlug("Fundraising")).toBe("fundraising");
    expect(tagSlug("  fundraising ")).toBe("fundraising");
    expect(tagSlug("FUNDRAISING")).toBe("fundraising");
  });

  test("accents fold to their base letter rather than cutting the word", () => {
    expect(tagSlug("Série A")).toBe("serie-a");
    expect(tagSlug("Diligencia — Legal")).toBe("diligencia-legal");
  });

  test("punctuation and spacing collapse to one dash, with no dash left dangling", () => {
    expect(tagSlug("Q3 2026")).toBe("q3-2026");
    expect(tagSlug("  --Board // Q3--  ")).toBe("board-q3");
    expect(tagSlug("it's mine")).toBe("its-mine");
  });

  test("a name with nothing matchable in it cannot become a tag", () => {
    expect(tagSlug("###")).toBe("");
    expect(tagSlug("   ")).toBe("");
    expect(isUsableTagName("###")).toBe(false);
    expect(isUsableTagName("ok")).toBe(true);
  });

  test("the display name keeps its case and collapses runs of whitespace", () => {
    expect(normalizeTagName("  Series   A  ")).toBe("Series A");
    expect(normalizeTagName("Fundraising")).toBe("Fundraising");
  });

  test("both forms are bounded by the same length", () => {
    const long = "a".repeat(TAG_NAME_MAX + 40);
    expect(normalizeTagName(long).length).toBe(TAG_NAME_MAX);
    expect(tagSlug(long).length).toBe(TAG_NAME_MAX);
  });
});

describe("tags/palette", () => {
  test("an unknown stored colour reads as the default rather than breaking a row", () => {
    expect(asTagColorKey("jade")).toBe("jade");
    expect(asTagColorKey("chartreuse")).toBe(DEFAULT_TAG_COLOR);
    expect(asTagColorKey(null)).toBe(DEFAULT_TAG_COLOR);
    expect(asTagColorKey(7)).toBe(DEFAULT_TAG_COLOR);
  });

  test("the first tags in a workspace each get a different colour", () => {
    const used: Partial<Record<(typeof TAG_COLOR_KEYS)[number], number>> = {};
    const picked: string[] = [];
    for (let i = 0; i < TAG_COLOR_KEYS.length; i++) {
      const next = nextTagColor(used);
      picked.push(next);
      used[next] = (used[next] ?? 0) + 1;
    }
    expect(new Set(picked).size).toBe(TAG_COLOR_KEYS.length);
  });

  test("past the palette it reuses the least-used colour, not the first", () => {
    const used = Object.fromEntries(TAG_COLOR_KEYS.map((k) => [k, 2])) as Record<string, number>;
    used[TAG_COLOR_KEYS[3]] = 1;
    expect(nextTagColor(used)).toBe(TAG_COLOR_KEYS[3]);
  });

  test("an empty workspace starts at the top of the palette", () => {
    expect(nextTagColor({})).toBe(TAG_COLOR_KEYS[0]);
  });
});

/**
 * The search a paged tag list runs.
 *
 * `listTagsPage` matches against the stored slug, which is already the folded form, so what a
 * person types never has to match how the tag was capitalised or accented. The escaping matters
 * because a tag name is user input: "Q3 (draft)" is a legal name, and its parentheses must not
 * reach Mongo as a regex group.
 */
describe("tags/search folding", () => {
  /** What the route does to a query before it becomes a `$regex`. */
  const needle = (q: string) => tagSlug(q).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

  test("a differently spelled query reaches the same tag", () => {
    // Stored slug for "Série A" is "serie-a"; each of these folds into a prefix of it.
    for (const typed of ["Série", "serie", "SERIE", "  série  "]) {
      expect(tagSlug("Série A").includes(needle(typed))).toBe(true);
    }
  });

  test("regex metacharacters in a query are escaped, not executed", () => {
    // "q3-draft" must not be matched by a pattern built from "(draft)" as a group.
    expect(needle("Q3 (draft)")).toBe(String.raw`q3-draft`);
    expect(needle("a.b")).toBe("a-b");
    // A name that folds to nothing searchable yields nothing to match on.
    expect(needle("!!!")).toBe("");
  });

  test("an empty query is not a filter", () => {
    expect(needle("")).toBe("");
    expect(needle("   ")).toBe("");
  });
});
