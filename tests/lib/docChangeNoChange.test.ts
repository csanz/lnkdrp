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

/**
 * The short-circuit must not answer "no changes" from having looked at nothing.
 *
 * It was written to stop the model inventing edits on an identical re-upload, and it overcorrected
 * into the mirror-image fault: two empty strings compare equal, and `imageChanged` is null rather
 * than true whenever a page carries no usable fingerprint, so a document nothing could read
 * satisfied both halves for free. Real rows in the app said "No changes: this version reads the
 * same as the previous one" on the same line as "13 to 18 pages".
 */
describe("runDocChangeDiff refuses to claim sameness it cannot support", () => {
  const text = "Slide one\nSlide two";

  it("does not report 'no changes' when the page count moved", async () => {
    // No API key in tests, so the real path returns null. The point is that it is not the fixed
    // no-change record: a version that gained five pages did not read the same as the last one.
    const diff = await runDocChangeDiff({
      previousText: text,
      newText: text,
      previousPageCount: 13,
      newPageCount: 18,
    });
    expect(diff?.summary).not.toBe(NO_CHANGE_SUMMARY);
  });

  it("still reports 'no changes' when the page count held", async () => {
    const diff = await runDocChangeDiff({
      previousText: text,
      newText: text,
      previousPageCount: 12,
      newPageCount: 12,
    });
    expect(diff).toEqual({ summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] });
  });

  it("does not report 'no changes' when neither side had text and no page carried a verdict", async () => {
    const diff = await runDocChangeDiff({
      previousText: "",
      newText: "",
      changedPages: [{ pageNumber: 1, previousText: "", newText: "", imageChanged: null }],
    });
    expect(diff?.summary).not.toBe(NO_CHANGE_SUMMARY);
  });

  it("does report 'no changes' when the images were checked and matched", async () => {
    // A scan with no text layer is the legitimate both-empty case: there the fingerprints answered,
    // and "false" is a verdict rather than an absence.
    const diff = await runDocChangeDiff({
      previousText: "",
      newText: "",
      changedPages: [{ pageNumber: 1, previousText: "", newText: "", imageChanged: false }],
    });
    expect(diff).toEqual({ summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] });
  });
});
