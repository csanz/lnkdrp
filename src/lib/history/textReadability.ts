/**
 * Is a page's extracted text actually readable, or is it glyph codes?
 *
 * A PDF stores glyph indices, and turning those back into characters needs the font's ToUnicode
 * map. Plenty of decks have fonts subset without one - design tools do it routinely - and pdfjs
 * then returns the indices themselves. They are real Unicode characters, so nothing errors and
 * nothing looks wrong until it reaches a screen, where a real deck produced this:
 *
 *     AɇȫǻͲ͈ɇڴ͙˷ȶǻυ֪͈ڴ͙ɿ̵ɇǻ͙͈ڴ˟˷γɇڴɨǻ͈͙ɇ̵ڴ͙ ɿǻ˦ڴɿͲ˟ǻ˦ڴ̵ɇ͈̬˷˦͈ɇֽ
 *
 * Measured across that document: 15-26% of characters were ASCII-printable, against the 90%+ a
 * readable English page gives. The comparison itself still worked - the images carry the page -
 * but showing the reader this is worse than showing them nothing.
 *
 * The honest limit of this test: a document genuinely written in Chinese, Arabic or Greek scores
 * the same way, because the signal is "is this Latin text" rather than "is this meaningful". The
 * consequence of a false positive is only that the word diff is replaced by a line saying the text
 * could not be read while the page images are still compared, which is a safe way to be wrong.
 * Anything stricter would need language detection to earn its keep.
 */

/**
 * Below this share of ASCII-printable characters, the text is not worth showing as words.
 *
 * Well under real prose, which runs above 90% even with curly quotes and accents, and well above
 * the 15-26% measured on a page whose fonts carried no character map.
 */
export const MIN_READABLE_RATIO = 0.6;

/** Too short to judge: a page with a handful of characters tells us nothing either way. */
const MIN_LENGTH = 24;

/** Share of characters that are ASCII-printable, ignoring whitespace. 0-1. */
export function readableRatio(input: string): number {
  const text = (input ?? "").replace(/\s+/g, "");
  if (!text.length) return 1;
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 32 && c < 127) ok += 1;
  }
  return ok / text.length;
}

/**
 * Should this text be shown to a reader as words?
 *
 * Empty and short strings pass: there is nothing to garble, and the caller has its own handling
 * for a page with no text.
 */
export function isReadableText(input: string): boolean {
  const text = (input ?? "").trim();
  if (text.length < MIN_LENGTH) return true;
  return readableRatio(text) >= MIN_READABLE_RATIO;
}
