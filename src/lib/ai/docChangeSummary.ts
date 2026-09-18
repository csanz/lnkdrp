/**
 * The one sentence a compare uses when nothing changed, and the check for it.
 *
 * It lives in its own leaf module (no AI SDK imports) so the page-level code in
 * `@/lib/history/changedPages` can enforce the invariant below without pulling the model client in.
 *
 * Invariant: a diff whose summary is the no-change record has an empty `pagesThatChanged`. The two
 * used to be produced independently, and a re-upload of the same deck showed "No changes: this
 * version reads the same as the previous one." directly above a list of all nine pages.
 */

/** What a compare says when the new version reads the same as the old one. */
export const NO_CHANGE_SUMMARY = "No changes: this version reads the same as the previous one.";

/** Is this summary the fixed no-change record? (Tolerates trailing whitespace from the model.) */
export function isNoChangeSummary(summary: unknown): boolean {
  return typeof summary === "string" && summary.trim() === NO_CHANGE_SUMMARY;
}
