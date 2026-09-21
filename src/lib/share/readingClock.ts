/**
 * The share viewer's reading clock, as a pure state machine.
 *
 * It owns both timers the stats POSTs report — the visit chunk (`durationMs`) and the current page's
 * segment (`pageDurationMs` + bounds) — and decides when each is flushed. Keeping it free of the DOM
 * lets the rules be unit-tested and lets the seed tooling drive the exact same logic in virtual time.
 *
 * Rules that matter for the owner's analytics:
 * - A final flush (hidden, pagehide, unmount) always sends what is left, however short: the page of the
 *   last timed event is the exit page, so dropping a short last segment moved the exit.
 * - Five minutes without input while visible ends the segment at `lastInputAt + 5 min` (reason `idle`),
 *   so a tab left open overnight is not read as hours on one page.
 * - No flush ever carries a zero or negative interval.
 * - The heartbeat reports the current page's time as it goes, and never as an exit. See
 *   `pageReportedMs`: the page clock used to move only when the page did, which meant a document
 *   with **one page** — a one-pager, a signed letter, a term sheet — recorded no per-page time at
 *   all until the tab was closed. The owner watching the reader live saw a visit clock climbing
 *   past a minute beside "time per page wasn't recorded", which is the one document where the two
 *   numbers are the same number.
 */

export const IDLE_AFTER_MS = 300_000;
export const MIN_CHUNK_MS = 1500;
export const ANTI_STORM_MS = 1200;
export const HEARTBEAT_MS = 30_000;
export const IDLE_CHECK_MS = 5000;

export type FlushReason = "turn" | "hidden" | "pagehide" | "unmount" | "heartbeat" | "idle";

export type Flush = {
  reason: FlushReason;
  durationMs: number | null;
  /**
   * `exit` is the difference between "they have left this page" and "they are still on it".
   *
   * Only an exit carries `enteredAtMs`/`leftAtMs` onto the wire, because those bounds are what the
   * server reads as an exit (`isPageExit`) — a page segment, a revisit tick, and the `toPage` that
   * tells a live metrics page which page they turned to. A heartbeat's segment is time on a page
   * they have not left yet, so it moves the clock and nothing else.
   */
  page: { pageNumber: number; enteredAtMs: number; leftAtMs: number; pageDurationMs: number; exit: boolean } | null;
  toPage?: number;
};

type FinalReason = "hidden" | "pagehide" | "unmount";

export class ReadingClock {
  private page: number;
  private visitStart: number | null;
  private pageStart: number | null;
  /**
   * How much of the current page's dwell has already been sent.
   *
   * The heartbeat reports the page as it goes, so without a ledger the exit flush would send the
   * whole dwell again — seconds already counted included. That exact double count is why the
   * heartbeat stopped carrying a page number in the first place; this is the same feature with the
   * accounting it was missing. Reset to zero wherever `pageStart` is, and only there.
   */
  private pageReportedMs = 0;
  private lastInputAt: number;
  private lastFlushAt = 0;
  private isIdle = false;
  private isHidden = false;
  private isStopped = false;

  constructor(opts: { now: number; page: number }) {
    this.page = opts.page;
    this.visitStart = opts.now;
    this.pageStart = opts.now;
    this.pageReportedMs = 0;
    this.lastInputAt = opts.now;
  }

  /**
   * What is left of the current page's dwell that has not been sent yet.
   *
   * Never rounded up. A one-millisecond floor would break the invariant the fuzz test holds —
   * reported page time must never exceed reported visit time, because every second on a page is a
   * second of the visit — and a property that catches double counting is worth more than the one
   * page segment this costs, in the millisecond where a turn lands on top of a heartbeat. The turn
   * itself still goes out; see `turn`.
   */
  private unreportedPageMs(until: number): number {
    if (this.pageStart === null) return 0;
    const total = until - this.pageStart;
    if (total < 1) return 0;
    return Math.max(0, total - this.pageReportedMs);
  }

  private checkIdle(now: number): Flush[] {
    if (this.isIdle || this.isHidden || this.isStopped) return [];
    if (now - this.lastInputAt <= IDLE_AFTER_MS) return [];
    const deadline = this.lastInputAt + IDLE_AFTER_MS;
    const out: Flush[] = [];
    const chunk = this.visitStart === null ? 0 : deadline - this.visitStart;
    const pageDur = this.unreportedPageMs(deadline);
    const durationMs = chunk >= 1 ? chunk : null;
    const page =
      pageDur >= 1 && this.pageStart !== null
        ? { pageNumber: this.page, enteredAtMs: this.pageStart, leftAtMs: deadline, pageDurationMs: pageDur, exit: true }
        : null;
    if (durationMs !== null || page !== null) out.push({ reason: "idle", durationMs, page });
    this.isIdle = true;
    this.visitStart = null;
    this.pageStart = null;
    this.pageReportedMs = 0;
    this.lastFlushAt = deadline;
    return out;
  }

  input(now: number): void {
    this.lastInputAt = now;
    if (this.isIdle && !this.isHidden && !this.isStopped) {
      this.isIdle = false;
      this.visitStart = now;
      this.pageStart = now;
      this.pageReportedMs = 0;
    }
  }

  turn(now: number, toPage: number): Flush[] {
    const idleFlushes = this.checkIdle(now);
    if (this.isIdle || this.isHidden || this.isStopped) {
      this.page = toPage;
      this.lastInputAt = now;
      if (!this.isHidden && !this.isStopped) {
        this.isIdle = false;
        this.visitStart = now;
        this.pageStart = now;
        this.pageReportedMs = 0;
      }
      return idleFlushes;
    }
    const pageStart = this.pageStart ?? now;
    // The gate is the *whole* dwell, as it always was — a page held for 20 seconds is a page they
    // read, whether or not a heartbeat already reported 19 of them. Only what goes on the wire is
    // net of what has been sent.
    const pageDur = now - pageStart;
    const chunk = now - (this.visitStart ?? now);
    const unreported = this.unreportedPageMs(now);
    const out: Flush[] = [];
    // Nothing left on either clock happens when a heartbeat landed a millisecond ago: it took the
    // visit chunk and the page's remainder with it. The same rule every other flush follows — no
    // flush ever carries a zero interval — so there is nothing to post.
    const durationMs = chunk >= 1 ? chunk : null;
    const page =
      unreported >= 1
        ? { pageNumber: this.page, enteredAtMs: pageStart, leftAtMs: now, pageDurationMs: unreported, exit: true }
        : null;
    if (pageDur >= MIN_CHUNK_MS && (durationMs !== null || page !== null)) {
      out.push({ reason: "turn", durationMs, page, toPage });
      this.visitStart = now;
      this.lastFlushAt = now;
    }
    /**
     * A suppressed turn leaves the visit clock running rather than resetting it.
     *
     * It used to reset unconditionally, so every flip under a second and a half silently threw
     * away the visit time since the last flush. A skimmer going through fifty pages at 300ms each
     * lost fifteen seconds that way — real reading time, in the counter the owner reads as "how
     * long were they here". The minimum chunk is there to stop a fast page-turner becoming a POST
     * storm, and holding the chunk over to the next flush obeys it without paying for it: one
     * post, all the seconds.
     */
    this.page = toPage;
    this.pageStart = now;
    this.pageReportedMs = 0;
    this.lastInputAt = now;
    return out;
  }

  heartbeat(now: number): Flush[] {
    const idleFlushes = this.checkIdle(now);
    if (idleFlushes.length) return idleFlushes;
    if (this.isIdle || this.isHidden || this.isStopped || this.visitStart === null) return [];
    if (this.lastFlushAt && now - this.lastFlushAt < ANTI_STORM_MS) return [];
    const chunk = now - this.visitStart;
    if (chunk < MIN_CHUNK_MS) return [];
    /**
     * The page's share of the same seconds, sent alongside and marked as not an exit.
     *
     * These are two counters over one interval, which is the whole reason `shareTiming` exists:
     * `durationMs` feeds the visit clock, `pageDurationMs` feeds the page clock, and neither ever
     * reads the other's number. What makes it safe this time is the ledger — the exit flush sends
     * only what is left, so the page turn no longer replays seconds already counted.
     */
    const unreported = this.unreportedPageMs(now);
    const page =
      unreported >= 1 && this.pageStart !== null
        ? { pageNumber: this.page, enteredAtMs: this.pageStart, leftAtMs: now, pageDurationMs: unreported, exit: false }
        : null;
    if (page) this.pageReportedMs += unreported;
    this.visitStart = now;
    this.lastFlushAt = now;
    return [{ reason: "heartbeat", durationMs: chunk, page }];
  }

  tick(now: number): Flush[] {
    return this.checkIdle(now);
  }

  hidden(now: number): Flush[] {
    return this.finalFlush(now, "hidden");
  }

  visible(now: number): void {
    if (this.isStopped) return;
    this.isHidden = false;
    this.isIdle = false;
    this.lastInputAt = now;
    this.visitStart = now;
    this.pageStart = now;
    this.pageReportedMs = 0;
  }

  pagehide(now: number): Flush[] {
    return this.finalFlush(now, "pagehide");
  }

  unmount(now: number): Flush[] {
    return this.finalFlush(now, "unmount");
  }

  snapshot(): {
    page: number;
    visitStart: number | null;
    pageStart: number | null;
    lastInputAt: number;
    lastFlushAt: number;
    idle: boolean;
    hidden: boolean;
    stopped: boolean;
  } {
    return {
      page: this.page,
      visitStart: this.visitStart,
      pageStart: this.pageStart,
      lastInputAt: this.lastInputAt,
      lastFlushAt: this.lastFlushAt,
      idle: this.isIdle,
      hidden: this.isHidden,
      stopped: this.isStopped,
    };
  }

  private markFinal(reason: FinalReason) {
    if (reason === "hidden") this.isHidden = true;
    else this.isStopped = true;
  }

  // No anti-storm or minimum-chunk guard here: whatever is left must reach the server.
  private finalFlush(now: number, reason: FinalReason): Flush[] {
    const idleFlushes = this.checkIdle(now);
    if (idleFlushes.length) {
      this.markFinal(reason);
      return idleFlushes;
    }
    if (this.isIdle || this.isHidden || this.isStopped) {
      this.markFinal(reason);
      return [];
    }
    const out: Flush[] = [];
    const chunk = this.visitStart === null ? 0 : now - this.visitStart;
    const pageDur = this.unreportedPageMs(now);
    const durationMs = chunk >= 1 ? chunk : null;
    const page =
      pageDur >= 1 && this.pageStart !== null
        ? { pageNumber: this.page, enteredAtMs: this.pageStart, leftAtMs: now, pageDurationMs: pageDur, exit: true }
        : null;
    if (durationMs !== null || page !== null) out.push({ reason, durationMs, page });
    this.visitStart = null;
    this.pageStart = null;
    this.pageReportedMs = 0;
    this.lastFlushAt = now;
    this.markFinal(reason);
    return out;
  }
}

export function buildTimingPayload(
  f: Flush,
  ctx: { botId: string; visitId: string; numPages: number | null },
): Record<string, unknown> {
  return {
    botId: ctx.botId,
    visitId: ctx.visitId,
    tv: 2,
    reason: f.reason,
    ...(ctx.numPages ? { numPages: Math.floor(ctx.numPages) } : {}),
    ...(f.durationMs ? { durationMs: Math.floor(f.durationMs) } : {}),
    ...(f.page
      ? {
          pageNumber: Math.floor(f.page.pageNumber),
          pageDurationMs: Math.floor(f.page.pageDurationMs),
          // Bounds are the exit signal (`isPageExit`), so a heartbeat's segment carries none: it
          // moves `pageTimeMsByPage` and writes no `pageEvents` entry and no revisit tick.
          ...(f.page.exit
            ? { enteredAtMs: Math.floor(f.page.enteredAtMs), leftAtMs: Math.floor(f.page.leftAtMs) }
            : {}),
        }
      : {}),
    ...(f.toPage ? { toPage: Math.floor(f.toPage) } : {}),
  };
}

export function buildSeenPayload(ctx: {
  botId: string;
  visitId: string | null;
  pageNumber: number;
  numPages: number | null;
}): Record<string, unknown> {
  return {
    botId: ctx.botId,
    ...(ctx.visitId ? { visitId: ctx.visitId } : {}),
    pageNumber: ctx.pageNumber,
    tv: 2,
    ...(ctx.numPages ? { numPages: Math.floor(ctx.numPages) } : {}),
  };
}
