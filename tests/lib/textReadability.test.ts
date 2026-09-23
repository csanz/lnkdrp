/**
 * Glyph codes are valid Unicode, so nothing about them errors: a page whose fonts were subset
 * without a ToUnicode map extracts cleanly and looks fine right up until it reaches a screen.
 * A real deck put this in front of the owner, under the heading "text on this page":
 *
 *     AɇȫǻͲ͈ɇڴ͙˷ȶǻυ֪͈ڴ͙ɿ̵ɇǻ͙͈ڴ˟˷γɇڴɨǻ͈͙ɇ̵ڴ͙ ɿǻ˦ڴɿͲ˟ǻ˦ڴ̵ɇ͈̬˷˦͈ɇֽ
 */
import { describe, expect, test } from "vitest";

import { MIN_READABLE_RATIO, isReadableText, readableRatio } from "@/lib/history/textReadability";

/** Verbatim from the document that prompted this, at the length the extractor produced. */
const GLYPH_CODES =
  "AɇȫǻͲ͈ɇڴ͙˷ȶǻυ֪͈ڴ͙ɿ̵ɇǻ͙͈ڴ˟˷γɇڴɨǻ͈͙ɇ̵ڴ͙ ɿǻ˦ڴɿͲ˟ǻ˦ڴ̵ɇ͈̬˷˦͈ɇֽ ͔̖˾ۓͧǻɂ̖ǻʒɦۓ̖ۓ̅ǻΑ͔ǻˠۓɕʱͧǻͧɦ";

const REAL =
  "Because today's threats move faster than human response. From sabotage to natural disasters, the speed and scale of modern crisis demand a new class of technology.";

describe("readable text is left alone", () => {
  test("ordinary prose scores high", () => {
    expect(readableRatio(REAL)).toBeGreaterThan(0.9);
    expect(isReadableText(REAL)).toBe(true);
  });

  test("curly quotes, accents and dashes do not sink it", () => {
    const fancy = "The founder's note - written in Montreal, revised in Sao Paulo - covers the raise and the runway in detail.";
    expect(isReadableText(fancy)).toBe(true);
  });

  test("short strings always pass: there is nothing to judge", () => {
    expect(isReadableText("")).toBe(true);
    expect(isReadableText("Team")).toBe(true);
    expect(isReadableText("ɇȫǻ")).toBe(true);
  });
});

describe("glyph codes are caught", () => {
  test("the real extraction is well under the threshold", () => {
    const ratio = readableRatio(GLYPH_CODES);
    expect(ratio).toBeLessThan(MIN_READABLE_RATIO);
    // The measured range across that document's pages was 15-26%.
    expect(ratio).toBeLessThan(0.4);
    expect(isReadableText(GLYPH_CODES)).toBe(false);
  });

  test("a page that is mostly glyph codes with some real words still fails", () => {
    // The shape of the page that prompted this: the original copy unreadable, an added line clean.
    expect(isReadableText(`${GLYPH_CODES} the next 18 months to help address some of`)).toBe(false);
  });

  test("a page that is mostly real words with a stray symbol passes", () => {
    expect(isReadableText(`${REAL} ֽ͈`)).toBe(true);
  });
});
