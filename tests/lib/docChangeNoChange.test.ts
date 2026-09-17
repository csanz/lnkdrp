import { describe, expect, it } from "vitest";

import { NO_CHANGE_SUMMARY, normalizeForCompare, runDocChangeDiff } from "../../src/lib/ai/docChangeDiff";

/**
 * Re-uploading the same file used to come back with invented edits ("reorganized sections",
 * "updated terminology"). Identical text must short-circuit before the model call.
 */
describe("runDocChangeDiff on an unchanged file", () => {
  const text = "USAvionix\nPhalanx AI\nSlide two: coverage and cost.";

  it("answers 'no changes' without calling the model", async () => {
    const diff = await runDocChangeDiff({ previousText: text, newText: text });
    expect(diff).toEqual({ summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] });
  });

  it("ignores whitespace-only differences", async () => {
    const diff = await runDocChangeDiff({ previousText: text, newText: `  ${text.replace(/\n/g, "\n\n")}  ` });
    expect(diff?.changes).toEqual([]);
  });

  it("still compares when a page's image changed", async () => {
    // No OPENAI_API_KEY in tests, so the real path returns null — the point is that it does not
    // return the fixed no-change record.
    const diff = await runDocChangeDiff({
      previousText: text,
      newText: text,
      changedPages: [{ pageNumber: 2, previousText: "same", newText: "same", imageChanged: true }],
    });
    expect(diff?.summary).not.toBe(NO_CHANGE_SUMMARY);
  });

  it("normalizeForCompare collapses whitespace", () => {
    expect(normalizeForCompare(" a \n\n b\t")).toBe("a b");
  });
});
