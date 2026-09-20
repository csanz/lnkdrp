/**
 * Where a reader is *now*, from a session row — the one rule, in one place.
 *
 * Both metrics scopes ask it: a document's own visits list, and a project's, where a session spans
 * several documents and the answer decides which row is green and which drill-down opens itself.
 * They had a copy each, and the copies were the bug: the project side learned that a one-page
 * document never produces a page event while the document side still believed it did.
 *
 * Two facts, and they do not come from the same field:
 *
 *   - **Which page** is the newest page event. Events are *exits* — a `turn` records `toPage`, the
 *     page they went to — so the newest one names where they are without any new write. A flush
 *     that was not a turn (a tab hidden, a reload) has no `toPage`, and there the page it ended on
 *     is the best answer there is. Failing both, the furthest page the row has seen: a document
 *     with one page has nowhere to turn to and so writes no event at all, which used to leave the
 *     whole live half of the reader page dark for exactly the documents where being sure is
 *     easiest. It is the last resort on purpose — an exit is evidence, a page visited at some
 *     point is an inference.
 *
 *   - **How recently** is the row's own `lastEventAt`, never the event's timestamp. Every stats
 *     post moves it, starting with the one the viewer sends the moment a document opens. The event
 *     is stamped when they *left* a page, so a reader going back to a file they had already read
 *     brought a timestamp from their last visit — and a room comparing those kept naming the
 *     document they had walked away from until they turned a page in the new one.
 *
 * `at` is deliberately not returned: the caller already holds `lastEventAt` and comparing rows is
 * its job. This answers the half that needs the rule.
 */

/** The page-event shape both collections store; only the fields this rule reads. */
export type PageEventLike = {
  pageNumber?: unknown;
  toPage?: unknown;
};

function asPage(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * The page a session row leaves the reader on, or `null` when the row says nothing at all.
 *
 * Tolerant of `unknown` by design: both callers hand it lean Mongo documents, where every field is
 * whatever the database happens to hold.
 */
export function currentPageFromRow(row: { pageEvents?: unknown; pagesSeen?: unknown }): number | null {
  const events = Array.isArray(row.pageEvents) ? (row.pageEvents as PageEventLike[]) : [];
  const last = events.length ? events[events.length - 1] : null;
  if (last) {
    const page = asPage(last.toPage) ?? asPage(last.pageNumber);
    if (page) return page;
  }
  const seen = Array.isArray(row.pagesSeen) ? (row.pagesSeen as unknown[]).map(asPage).filter((n): n is number => n !== null) : [];
  return seen.length ? Math.max(...seen) : null;
}
