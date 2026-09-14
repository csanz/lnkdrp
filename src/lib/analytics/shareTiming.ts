/**
 * How one stats heartbeat turns into time counters.
 *
 * The viewer runs two clocks over the same wall-clock seconds:
 *
 * - the **visit clock**, reported as `durationMs`, which feeds `timeSpentMs` — "how long was this
 *   person reading"
 * - the **page clock**, reported as `pageDurationMs`, which feeds `pageTimeMsByPage` — "how long
 *   were they on page 4"
 *
 * They overlap by construction: the seconds you spend on page 4 are seconds of the visit. So a
 * single number cannot feed both counters, and the two rules below exist to keep each interval
 * reported exactly once per counter.
 *
 * This has now failed in both directions, which is why it is a module with tests rather than four
 * lines inside a route handler:
 *
 * - First the page-change POST never fired at all (the viewer's sync effect was overwriting the ref
 *   the dwell effect compares against), so per-page time came only from the heartbeat and every
 *   page's time was credited to whichever page happened to be open when it fired.
 * - Then, with the page-change POST restored, the heartbeat was still sending its *visit* chunk
 *   with a `pageNumber` attached and not resetting the page clock. The page's own segment arrived
 *   again on the next page turn, time already counted included. A three-page read of 7.9s, 5.6s and
 *   6.7s stored 20.3s against page 3, and the document total ran 26% high.
 */

/** One heartbeat's timing fields, already parsed and range-checked by the route. */
export type TimingPayload = {
  /** The visit clock since the last flush. */
  durationMs: number | null;
  /** The page clock since the last flush or page turn. */
  pageDurationMs: number | null;
  /** Page interval bounds, when the client could supply them (epoch ms). */
  enteredAtMs: number | null;
  leftAtMs: number | null;
};

/** A day, as a ceiling on any single reported interval. */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Time to add to `timeSpentMs` — the visit clock, and nothing else.
 *
 * Deliberately does not fall back to the page segment: a page-turn POST reports an interval that is
 * already inside the visit chunk the heartbeat reports, so counting it here adds those seconds to
 * the document and visit totals twice.
 */
export function visitTimeIncrement(payload: TimingPayload): number | null {
  const { durationMs } = payload;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.floor(Math.min(durationMs, MAX_INTERVAL_MS));
}

/**
 * Time to add to `pageTimeMsByPage[page]` — the page clock.
 *
 * Falls back to the reported interval (`leftAtMs - enteredAtMs`) and then, last, to `durationMs`.
 * That final fallback is the compatibility path for a tab still running the build that sent one
 * number for both clocks: it over-counts exactly as that build always did, which is better than
 * silently dropping the page time of every open tab on the day this ships.
 */
export function pageTimeIncrement(payload: TimingPayload): number | null {
  const { pageDurationMs, enteredAtMs, leftAtMs, durationMs } = payload;
  if (typeof pageDurationMs === "number" && Number.isFinite(pageDurationMs) && pageDurationMs > 0) {
    return Math.floor(Math.min(pageDurationMs, MAX_INTERVAL_MS));
  }
  if (
    typeof enteredAtMs === "number" &&
    typeof leftAtMs === "number" &&
    Number.isFinite(enteredAtMs) &&
    Number.isFinite(leftAtMs) &&
    leftAtMs > enteredAtMs
  ) {
    return Math.floor(Math.min(leftAtMs - enteredAtMs, MAX_INTERVAL_MS));
  }
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
    return Math.floor(Math.min(durationMs, MAX_INTERVAL_MS));
  }
  return null;
}
