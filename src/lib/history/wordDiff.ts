/**
 * A word-level diff of one page's text.
 *
 * The region boxes answer "where on the page", and on a block that was rewritten wholesale that is
 * one box around the whole block - correct, and no more than the reader already knew. This answers
 * the question they actually came with: which words.
 *
 * Deterministic, free, and no dependency. It runs on text both versions already carry, needs no
 * model, and works on rows whose compare was skipped for credits.
 *
 * Word-level rather than character-level on purpose. A character diff of prose fragments words into
 * unreadable confetti - "revision" against "revisions" becomes a highlight around one letter buried
 * in a sentence - whereas replacing the whole word is how a person describes the change out loud.
 * Whitespace is folded into the tokens so the reassembled text still reads as a sentence.
 */

/** One run of text, and whether it survived from the previous version to the new one. */
export type DiffSpan = { type: "same" | "removed" | "added"; text: string };

/**
 * Longest common subsequence gets quadratic in memory, so very long pages fall back to reporting
 * the whole thing replaced rather than allocating a matrix nobody asked for. Page text is capped
 * well below this in practice.
 */
const MAX_TOKENS = 2_000;

/** Split into words, keeping the trailing whitespace on each so a join restores the original. */
export function tokenize(input: string): string[] {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  return text.match(/\S+\s*/g) ?? [];
}

/** Compare for equality: case and surrounding space are not a change worth showing. */
function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The spans that turn the previous text into the new one.
 *
 * Adjacent spans of the same kind are merged, so a run of changed words is one highlight rather
 * than one per word.
 */
export function wordDiff(previous: string, next: string): DiffSpan[] {
  const a = tokenize(previous);
  const b = tokenize(next);

  if (!a.length && !b.length) return [];
  if (!a.length) return [{ type: "added", text: b.join("") }];
  if (!b.length) return [{ type: "removed", text: a.join("") }];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      { type: "removed", text: a.join("") },
      { type: "added", text: b.join("") },
    ];
  }

  // Standard LCS table. Rows are the previous version, columns the new one.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = same(a[i], b[j])
        ? lcs[(i + 1) * cols + (j + 1)] + 1
        : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + (j + 1)]);
    }
  }

  const out: DiffSpan[] = [];
  const push = (type: DiffSpan["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) {
      // Keep the new version's spelling: it is the one being displayed as current.
      push("same", b[j]);
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + (j + 1)]) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    push("removed", a[i]);
    i += 1;
  }
  while (j < b.length) {
    push("added", b[j]);
    j += 1;
  }

  return out;
}

/** How much of the page's wording moved, 0-1, for deciding whether a diff is worth rendering. */
export function changedFraction(spans: DiffSpan[]): number {
  let changed = 0;
  let total = 0;
  for (const s of spans) {
    const n = s.text.length;
    total += n;
    if (s.type !== "same") changed += n;
  }
  return total ? changed / total : 0;
}

/**
 * Beyond this share of the wording moving, interleaving the two versions stops being readable.
 *
 * Measured on a real rewritten page: 79% of the passage changed and the result was thirty spans,
 * because common little words - "the", "and", "of" - keep matching and shatter the diff around
 * them. Every span is correct and the whole is noise. The owner's own reaction on seeing it was to
 * ask for the full paragraph instead, which is the right call: past this point the honest display
 * is the old passage and the new one, whole, side by side.
 */
export const INLINE_MAX_CHANGED = 0.45;

/** Beyond this many separate edits, the same readability problem arrives by a different route. */
export const INLINE_MAX_RUNS = 8;

export type DiffPresentation =
  | { mode: "identical" }
  /** A handful of edits: show one passage with the changes marked in place. */
  | { mode: "inline"; spans: DiffSpan[] }
  /** A rewrite: show both passages whole, because weaving them together reads as noise. */
  | { mode: "blocks"; previous: string; next: string; changed: number };

/**
 * Decide how this page's text is best shown, and prepare it.
 *
 * The choice is the whole difference between a diff somebody reads and one they give up on.
 */
export function diffPresentation(previous: string, next: string): DiffPresentation {
  const spans = wordDiff(previous, next);
  if (!spans.length || !spans.some((s) => s.type !== "same")) return { mode: "identical" };

  const changed = changedFraction(spans);
  const runs = spans.filter((s) => s.type !== "same").length;
  if (changed > INLINE_MAX_CHANGED || runs > INLINE_MAX_RUNS) {
    return {
      mode: "blocks",
      previous: tokenize(previous).join("").trim(),
      next: tokenize(next).join("").trim(),
      changed,
    };
  }
  return { mode: "inline", spans };
}
