import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/pdf/renderPage", () => ({ openPdfDocument: vi.fn() }));

import { attachPageContext, computeChangedPages, pageTextHash } from "@/lib/history/changedPages";

describe("changed pages", () => {
  test("text hashing ignores whitespace and case", () => {
    expect(pageTextHash("Hello   World\n")).toBe(pageTextHash("hello world"));
  });

  test("finds text and image changes, carries both versions' text and thumbnails", () => {
    const pages = computeChangedPages({
      prevPages: [
        { page_number: 1, text: "Intro" },
        { page_number: 2, text: "Pricing: three tiers" },
        { page_number: 3, text: "Team" },
      ],
      newPages: [
        { page_number: 1, text: "intro" },
        { page_number: 2, text: "Pricing: one tier" },
        { page_number: 3, text: "Team" },
      ],
      prevSlideNodes: [
        { pageNumber: 1, imageHash: "a", thumbUrl: "p1" },
        { pageNumber: 3, imageHash: "c", thumbUrl: "p3" },
      ],
      nextSlideNodes: [
        { pageNumber: 1, imageHash: "a", thumbUrl: "n1" },
        { pageNumber: 3, imageHash: "c2", thumbUrl: "n3" },
      ],
    });
    expect(pages.map((p) => p.pageNumber)).toEqual([2, 3]);
    expect(pages[0]).toMatchObject({ previousText: "Pricing: three tiers", newText: "Pricing: one tier", imageChanged: null });
    expect(pages[1]).toMatchObject({ previousImageUrl: "p3", newImageUrl: "n3", imageChanged: true });
  });

  test("caps the context at maxPages", () => {
    const prevPages = Array.from({ length: 20 }, (_, i) => ({ page_number: i + 1, text: `a${i}` }));
    const newPages = Array.from({ length: 20 }, (_, i) => ({ page_number: i + 1, text: `b${i}` }));
    expect(computeChangedPages({ prevPages, newPages, prevSlideNodes: [], nextSlideNodes: [] })).toHaveLength(12);
  });

  test("attaches thumbnails to listed pages and adds image-only pages", () => {
    const diff = { summary: "s", changes: [], pagesThatChanged: [{ pageNumber: 2, summary: "Pricing changed" }] } as never;
    // The per-page text rides along too: the viewer word-diffs it to show which words moved, which
    // is the one thing a box drawn around a rewritten block cannot say.
    const out = attachPageContext(diff, [
      { pageNumber: 2, previousText: "Pricing: three tiers", newText: "Pricing: one tier", previousImageUrl: "p2", newImageUrl: "n2", imageChanged: false },
      { pageNumber: 5, previousText: "", newText: "", previousImageUrl: "p5", newImageUrl: "n5", imageChanged: true },
    ]) as { pagesThatChanged: Array<Record<string, unknown>> };
    expect(out.pagesThatChanged).toEqual([
      {
        pageNumber: 2,
        summary: "Pricing changed",
        previousImageUrl: "p2",
        newImageUrl: "n2",
        imageChanged: false,
        previousText: "Pricing: three tiers",
        newText: "Pricing: one tier",
      },
      {
        pageNumber: 5,
        summary: "Graphics/visuals changed on this page.",
        previousImageUrl: "p5",
        newImageUrl: "n5",
        imageChanged: true,
        previousText: "",
        newText: "",
      },
    ]);
    expect(attachPageContext(null, [])).toBeNull();
  });
});
