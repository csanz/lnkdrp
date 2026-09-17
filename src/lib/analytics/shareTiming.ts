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
 * Time to add to `pageTimeMsByPage[page]` — the page clock, and never the visit clock.
 *
 * Falls back to the reported interval (`leftAtMs - enteredAtMs`), which describes the same page,
 * and stops there. It used to fall back once more, to `durationMs`, as a compatibility path for a
 * tab still running the build that sent one number for both clocks — and that fallback is the
 * original double count, preserved. A heartbeat carrying a page number and a visit chunk would have
 * its visit time credited to the page, which is precisely the bug the split was made to kill.
 *
 * The current viewer sends no page number on a heartbeat at all, so the path is unreachable from
 * it; the fallback only ever applied to stale tabs, and an honest undercount for those beats a
 * silent over-count that looks exactly like real reading time.
 */
export function pageTimeIncrement(payload: TimingPayload): number | null {
  const { pageDurationMs, enteredAtMs, leftAtMs } = payload;
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
  return null;
}

/**
 * Does this heartbeat describe a page the reader has *left*?
 *
 * Only then may it become a `pageEvents` segment and a `pageVisitCountByPage` increment — that
 * counter means "they came back to page 2", and it is read as a revisit in the visit detail. The
 * signal is the page interval: the viewer sends `enteredAtMs`/`leftAtMs` only when a page ends (a
 * page turn, `pagehide`, the tab being hidden, unmount), never on the 30-second heartbeat.
 *
 * The heartbeat used to send an interval too, so a single 25-second stay on page 2 arrived as two
 * segments and the visit detail showed a revisit that never happened. Keeping the rule here, next
 * to the two increments, is what stops the next change to the flush logic from reintroducing it.
 */
export function isPageExit(payload: TimingPayload): boolean {
  const { enteredAtMs, leftAtMs } = payload;
  return (
    typeof enteredAtMs === "number" &&
    typeof leftAtMs === "number" &&
    Number.isFinite(enteredAtMs) &&
    Number.isFinite(leftAtMs) &&
    leftAtMs > enteredAtMs
  );
}

/** Why the viewer's reading clock flushed (`src/lib/share/readingClock.ts`), as sent on the wire. */
export const FLUSH_REASONS = ["turn", "hidden", "pagehide", "unmount", "heartbeat", "idle"] as const;
export type FlushReasonWire = (typeof FLUSH_REASONS)[number];

function boundedInteger(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v >= min && v <= max ? v : null;
}

/** `tv`: the timing protocol version. Absent on payloads from viewers built before it existed. */
export function parseTimingVersion(v: unknown): number | null {
  return boundedInteger(v, 1, 9);
}

export function parseFlushReason(v: unknown): FlushReasonWire | null {
  return typeof v === "string" && (FLUSH_REASONS as readonly string[]).includes(v) ? (v as FlushReasonWire) : null;
}

/** A page number or page count from the client (`toPage`, `numPages`). */
export function parsePageBound(v: unknown): number | null {
  return boundedInteger(v, 1, 5000);
}

/**
 * Does this segment mean the reader left the page (so coming back to it is a revisit)?
 *
 * A tab being hidden or an idle cut splits one stay into two segments without the reader going
 * anywhere. Legacy payloads carry no reason and keep the old behaviour.
 */
export function countsAsPageRevisit(reason: FlushReasonWire | null): boolean {
  return reason !== "hidden" && reason !== "idle";
}
