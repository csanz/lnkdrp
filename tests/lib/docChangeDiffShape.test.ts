/**
 * A compare answer that runs long is clipped, not rejected.
 *
 * The model-facing schema used to carry the storage caps (`.max(400)` on the summary, `.strict()`
 * on every object), so one over-long sentence or one extra key failed the whole compare with
 * "No object generated: response did not match schema" after the customer had paid for it. The
 * schema is now lenient and `shapeDiff` applies the caps `DocChange.diff` needs.
 */
import { describe, expect, test } from "vitest";

import { DocChangeDiffSchema, shapeDiff } from "@/lib/ai/docChangeDiff";

describe("DocChangeDiffSchema", () => {
  test("accepts an over-long summary and an unknown key, stripping the key", () => {
    const parsed = DocChangeDiffSchema.parse({
      summary: "x".repeat(1200),
      changes: [{ type: "text", title: "Pricing", detail: null, confidence: 0.9 }],
      pagesThatChanged: [{ pageNumber: 3, summary: "y".repeat(900), regionNotes: ["a", "b", "c", "d", "e"], extra: true }],
    });
    expect(parsed.summary.length).toBe(1200);
    expect("confidence" in parsed.changes[0]).toBe(false);
    expect("extra" in parsed.pagesThatChanged[0]).toBe(false);
  });
});

describe("shapeDiff", () => {
  test("clips every field to what DocChange stores", () => {
    const shaped = shapeDiff({
      summary: " " + "s".repeat(500),
      changes: [],
      pagesThatChanged: [
        { pageNumber: 2, summary: "p".repeat(300), previousWording: "w".repeat(400), newWording: "", regionNotes: ["n".repeat(200), "ok", "", "three", "four"] },
        { pageNumber: 0, summary: "dropped: page numbers start at 1" },
      ],
    });
    expect(shaped.summary.length).toBe(400);
    expect(shaped.pagesThatChanged).toHaveLength(1);
    const page = shaped.pagesThatChanged[0];
    expect(page.summary.length).toBe(220);
    expect(page.previousWording?.length).toBe(300);
    expect(page.newWording).toBeNull();
    expect(page.regionNotes).toEqual(["n".repeat(160), "ok", "three"]);
  });

  test("keeps more than thirty changed pages down to thirty", () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, summary: `page ${i + 1}` }));
    expect(shapeDiff({ summary: "many", changes: [], pagesThatChanged: pages }).pagesThatChanged).toHaveLength(30);
  });
});
