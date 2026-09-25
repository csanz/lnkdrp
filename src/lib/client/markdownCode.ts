/**
 * Telling a fenced code block from an inline span under react-markdown v9+.
 *
 * Older react-markdown passed an `inline` prop to the `code` component. v9 removed it, so a renderer
 * that still branches on `inline` sees `undefined` for every span, treats each one as a block, and
 * wraps it in its own `<pre>` while react-markdown's default `pre` is still around it: every inline
 * `code` became a bordered block nested in a `<pre>`, in the summaries and the help articles alike.
 *
 * The signal that survives is the class remark puts on a fenced block (`language-xxx`), plus a
 * newline in the text for a fence with no language. Renderers that use this must also override
 * `pre` to render its children bare, so the block component owns the `<pre>`.
 */

/** The text of a code node's children as react-markdown hands them over (a string, or an array of them). */
export function codeText(children: unknown): string {
  if (Array.isArray(children)) return children.map((c) => String(c)).join("");
  return String(children ?? "");
}

/** True for a fenced block (a `language-` class, or text spanning lines); false for an inline span. */
export function isBlockCode(className: string | undefined, text: string): boolean {
  return /(^|\s)language-/.test(className ?? "") || text.includes("\n");
}
