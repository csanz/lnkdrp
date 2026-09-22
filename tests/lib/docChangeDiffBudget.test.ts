/**
 * The compare has to fit in a context window, and for a while it did not.
 *
 * Two numbers, both measured against the live OpenAI API on 2026-09-22 with one generated image per
 * request and the no-image request subtracted as a baseline:
 *
 *   image             gpt-4o-mini    gpt-4o
 *   480x270  (thumb)       8,500       255
 *   768x432               14,167       425
 *   1024x576              25,501       765
 *   1200x675 (render)     36,835     1,105
 *
 * The ratio is exactly 33.33 at every size, and it settles a question the documented tiling rule
 * leaves open: an image whose shortest side is already under 768px is *not* scaled up. A 480x270
 * thumb really is one tile, so moving the compare to the 1200px render is not free - it is 4.3x,
 * and on gpt-4o-mini an advanced compare's twenty images come to 736,700 tokens against a 128k
 * window. That is not expensive, it is impossible, and it fails hardest on the replacement with the
 * most changed pages: the one the owner most wants explained.
 *
 * These tests pin the two decisions that answer it, because both are invisible at the call site and
 * a plausible-looking edit to either brings the failure straight back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(path.join(process.cwd(), "src/lib/ai/docChangeDiff.ts"), "utf8");

describe("which model reads a compare", () => {
  it("sends image-bearing compares to gpt-4o and text-only ones to gpt-4o-mini", () => {
    // The split is by modality, not by tier. Tiles are 33x dearer on mini while its input price is
    // only 16.67x cheaper, so the same page image costs about twice as much there in dollars - and
    // twenty of them do not fit at all.
    expect(SOURCE).toMatch(/function modelForCompare\(hasImages: boolean\): string \{\s*return hasImages \? "gpt-4o" : "gpt-4o-mini";/);
  });

  it("does not hardcode a model at the call site", () => {
    // `model: openai("gpt-4o-mini")` was the whole bug: no call site ever asked what it was sending.
    expect(SOURCE).toContain("model: openai(modelId)");
    expect(SOURCE).not.toContain('model: openai("gpt-4o-mini")');
  });
});

describe("the per-page context block is bounded by tier", () => {
  it("scales the per-page slice instead of always allowing 6,000 characters", () => {
    // Twelve changed pages x two sides x 6,000 chars is ~36k tokens - on basic, over three times
    // that tier's entire text budget, and mostly words already present in the two full texts.
    expect(SOURCE).toMatch(/const perPageChars =[\s\S]{0,120}"advanced" \? 6_000[\s\S]{0,60}"basic" \? 1_500[\s\S]{0,20}: 3_000/);
    expect(SOURCE).toContain("normalizePageText(p.previousText, perPageChars)");
    expect(SOURCE).toContain("normalizePageText(p.newText, perPageChars)");
  });

  it("leaves no unbounded 6000-character slice behind", () => {
    // normalizePageText used to hardcode the cap; the argument is what makes the tier mean anything.
    expect(SOURCE).toMatch(/function normalizePageText\(input: string, max: number\)/);
    expect(SOURCE).not.toMatch(/\.slice\(0, 6000\)/);
  });
});

describe("what a compare cost is recorded", () => {
  it("captures usage from the model call and reports the model that produced it", () => {
    // Without this, every claim about tier pricing is arithmetic over a tiling rule nobody measured
    // - which is how the 1200px switch shipped described as token-neutral when it was 4.3x.
    expect(SOURCE).toContain("const { object, usage } = await generateObject(");
    expect(SOURCE).toMatch(/inputTokens: n\(usage\?\.inputTokens\)/);
    expect(SOURCE).toMatch(/model: modelId,/);
  });

  it("counts the images so a token total can be attributed", () => {
    expect(SOURCE).toMatch(/imagesAttached \+= 1;/);
    expect(SOURCE).toContain("pagesAttached = attachedPages;");
  });
});
