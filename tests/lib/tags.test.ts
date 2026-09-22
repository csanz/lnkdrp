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

  test("a name written in another script is a name, not an empty fold", () => {
    // The class used to be [^a-z0-9], so each of these folded to "" and every caller answered
    // "A tag needs at least one letter or number" to a field the UI had just accepted.
    expect(tagSlug("\u0424\u0430\u043d\u0434\u0440\u0430\u0438\u0437\u0438\u043d\u0433")).toBe("\u0444\u0430\u043d\u0434\u0440\u0430\u0438\u0437\u0438\u043d\u0433");
    expect(tagSlug("\u6295\u8cc7\u5bb6\u5411\u3051")).toBe("\u6295\u8cc7\u5bb6\u5411\u3051");
    expect(tagSlug("\u05d4\u05e0\u05e4\u05e7\u05d4")).toBe("\u05d4\u05e0\u05e4\u05e7\u05d4");
    for (const name of ["\u0424\u0430\u043d\u0434\u0440\u0430\u0438\u0437\u0438\u043d\u0433", "\u6295\u8cc7\u5bb6\u5411\u3051", "\u03a7\u03c1\u03b7\u03bc\u03b1\u03c4\u03bf\u03b4\u03cc\u03c4\u03b7\u03c3\u03b7", "\u062a\u0645\u0648\u064a\u0644", "\u05d4\u05e0\u05e4\u05e7\u05d4"]) {
      expect(isUsableTagName(name)).toBe(true);
    }
    // Marks that carry the word survive: dashing Devanagari matras out would merge unlike names.
    expect(tagSlug("\u092b\u0902\u0921\u0930\u0947\u091c\u093f\u0902\u0917")).toBe("\u092b\u0902\u0921\u0930\u0947\u091c\u093f\u0902\u0917");
    // Nothing matchable is still nothing matchable.
    expect(tagSlug("\ud83c\udf89")).toBe("");
    expect(isUsableTagName("###")).toBe(false);
  });

  test("the two spellings of Stra\u00dfe are one tag", () => {
    expect(tagSlug("Stra\u00dfe")).toBe("strasse");
    expect(tagSlug("Strasse")).toBe(tagSlug("Stra\u00dfe"));
  });

  test("the fold is stable, so a stored slug still finds its own tag", () => {
    // /api/tags/by-slug re-folds the segment it is handed. A slug that folds to something else
    // 404s on its own page: NFKD turns each \ufb01 into "fi", so a 60-character name can fold past
    // the cap and the cut can re-expose a separator that was already stripped.
    const ligature = "\ufb01!".repeat(30);
    expect(ligature.length).toBe(TAG_NAME_MAX);
    expect(tagSlug(ligature).endsWith("-")).toBe(false);
    for (const name of [ligature, "\ufb01x!".repeat(20), "a" + "\ud801\udc00".repeat(40), "  --Board // Q3--  ", "S\u00e9rie A", "\u6295\u8cc7\u5bb6\u5411\u3051"]) {
      const slug = tagSlug(name);
      expect(tagSlug(slug)).toBe(slug);
      expect(slug.length).toBeLessThanOrEqual(TAG_NAME_MAX);
    }
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
