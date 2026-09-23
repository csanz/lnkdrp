/**
 * The word diff is the part that answers "what actually changed".
 *
 * A region box says where on the page, and on a paragraph rewritten wholesale that is one box
 * around the paragraph - correct, and no more than the reader already knew. These pin the
 * behaviours that make the alternative readable rather than confetti.
 */
import { describe, expect, test } from "vitest";

import { INLINE_MAX_CHANGED, changedFraction, diffPresentation, tokenize, wordDiff } from "@/lib/history/wordDiff";

/**
 * The rendered result, as the reader sees it, for readable assertions.
 *
 * The markers wrap the span without swallowing its trailing space: tokens carry their own spacing
 * so the passage still reads as a sentence once reassembled, and a helper that trimmed it made
 * correct output look wrong.
 */
function render(previous: string, next: string): string {
  return wordDiff(previous, next)
    .map((s) => {
      if (s.type === "same") return s.text;
      const body = s.text.replace(/\s+$/, "");
      const tail = s.text.slice(body.length);
      return (s.type === "removed" ? `[-${body}-]` : `[+${body}+]`) + tail;
    })
    .join("")
    .trim();
}

describe("word diff", () => {
  test("identical text has no marked spans", () => {
    const spans = wordDiff("The ask is unchanged at 15M.", "The ask is unchanged at 15M.");
    expect(spans.every((s) => s.type === "same")).toBe(true);
  });

  test("a changed word is marked, the sentence around it is not", () => {
    expect(render("The ask is 15M.", "The ask is 22M.")).toBe("The ask is [-15M.-][+22M.+]");
  });

  test("an inserted clause is added without touching what surrounds it", () => {
    expect(render("Every claim carries its source.", "Every claim now carries its source.")).toBe(
      "Every claim [+now+] carries its source.",
    );
  });

  test("a deletion is marked as removed", () => {
    expect(render("the hiring plan comes out entirely", "the plan comes out entirely")).toBe(
      "the [-hiring-] plan comes out entirely",
    );
  });

  test("runs of changed words merge into one span rather than one per word", () => {
    // One highlight per word is the confetti this exists to avoid. Adjacent spans of a kind are
    // merged, so the count here is the number of genuinely separate edits, not the word count:
    // "revision," and "the" really do survive the rewrite and really do sit between the edits.
    const spans = wordDiff("Third revision, after the partner meeting.", "Fourth revision, the diligence version.");
    const words = "Third revision, after the partner meeting.".split(" ").length;
    expect(spans.filter((s) => s.type === "removed").length).toBeLessThan(words);
    expect(spans.filter((s) => s.type === "added").length).toBeLessThanOrEqual(3);
  });

  test("a long shared run stays one span", () => {
    const spans = wordDiff("alpha one two three four five omega", "beta one two three four five omega");
    expect(spans.filter((s) => s.type === "same")).toHaveLength(1);
  });

  test("case and spacing alone are not a change", () => {
    const spans = wordDiff("Series A  Deck", "series a deck");
    expect(spans.every((s) => s.type === "same")).toBe(true);
  });

  test("one empty side is wholly added or wholly removed", () => {
    expect(wordDiff("", "brand new page")).toEqual([{ type: "added", text: "brand new page" }]);
    expect(wordDiff("page is gone", "")).toEqual([{ type: "removed", text: "page is gone" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  test("the new version's spelling is what survives in the shared spans", () => {
    // Both are "same" under the case-insensitive compare; the current version is the one displayed.
    const spans = wordDiff("THE ASK", "The ask");
    expect(spans.map((s) => s.text).join("")).toContain("The ask");
  });
});

describe("changedFraction", () => {
  test("nothing changed is zero, everything changed is one", () => {
    expect(changedFraction(wordDiff("same words here", "same words here"))).toBe(0);
    expect(changedFraction(wordDiff("alpha beta", "gamma delta"))).toBe(1);
  });

  test("a small edit in a long passage stays small", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve";
    expect(changedFraction(wordDiff(long, long.replace("seven", "SEVEN!")))).toBeLessThan(0.35);
  });
});

describe("tokenize", () => {
  test("keeps trailing space so a join restores the sentence", () => {
    expect(tokenize("a  b c").join("")).toBe("a b c");
  });

  test("blank input is no tokens", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("diffPresentation picks a readable shape", () => {
  test("a few edits stay inline, inside the sentence they belong to", () => {
    const r = diffPresentation("The ask is unchanged at 15M.", "The ask is unchanged at 22M.");
    expect(r.mode).toBe("inline");
  });

  test("a rewritten passage shows both versions whole", () => {
    // The real page that prompted this: interleaving gave thirty spans, because "the" kept
    // matching and shattered the passage around it.
    const prev =
      "Third revision, after the partner meeting. The deck is shorter: the market section drops from four slides to one, the dispatch automation results move forward, and the hiring plan comes out entirely.";
    const next =
      "Fourth revision, the diligence version. Every claim now carries its source: ARR reconciled to the Stripe export, retention computed on the cohort table in the appendix, and the pipeline figures tied to the CRM snapshot.";
    const r = diffPresentation(prev, next);
    expect(r.mode).toBe("blocks");
    if (r.mode === "blocks") {
      expect(r.changed).toBeGreaterThan(INLINE_MAX_CHANGED);
      expect(r.previous).toContain("partner meeting");
      expect(r.next).toContain("diligence version");
    }
  });

  test("many scattered small edits also fall back to whole passages", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
    const edited = words.map((w, i) => (i % 4 === 0 ? `${w}X` : w));
    const r = diffPresentation(words.join(" "), edited.join(" "));
    expect(r.mode).toBe("blocks");
  });

  test("identical text says so rather than rendering an empty diff", () => {
    expect(diffPresentation("same here", "same here")).toEqual({ mode: "identical" });
  });
});

describe("an empty pair is not agreement", () => {
  test("two empty strings are identical to each other but say nothing about the page", () => {
    // The recipient's compare receives no extracted text at all - the share payload carries the
    // model's wordings instead - so both sides arrive as "". `isReadableText("")` is true, because
    // short strings have nothing to garble, so the empty pair looked like a readable one: the
    // wordings were dropped and this told the reader the words on the page were identical while
    // the same component printed the real before and after one click behind it.
    //
    // `diffPresentation` is right to call two empty strings identical; the caller is what must not
    // say so out loud. This pins the shape so the caller's guard has something to sit against.
    expect(diffPresentation("", "")).toEqual({ mode: "identical" });
  });

  test("a real pair that matches is still identical", () => {
    expect(diffPresentation("the ask is unchanged", "the ask is unchanged")).toEqual({ mode: "identical" });
  });
});
