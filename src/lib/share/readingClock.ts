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
  page: { pageNumber: number; enteredAtMs: number; leftAtMs: number; pageDurationMs: number } | null;
  toPage?: number;
};

type FinalReason = "hidden" | "pagehide" | "unmount";

export class ReadingClock {
  private page: number;
  private visitStart: number | null;
  private pageStart: number | null;
  private lastInputAt: number;
  private lastFlushAt = 0;
  private isIdle = false;
  private isHidden = false;
  private isStopped = false;

  constructor(opts: { now: number; page: number }) {
    this.page = opts.page;
    this.visitStart = opts.now;
    this.pageStart = opts.now;
    this.lastInputAt = opts.now;
  }

  private checkIdle(now: number): Flush[] {
    if (this.isIdle || this.isHidden || this.isStopped) return [];
    if (now - this.lastInputAt <= IDLE_AFTER_MS) return [];
    const deadline = this.lastInputAt + IDLE_AFTER_MS;
    const out: Flush[] = [];
    const chunk = this.visitStart === null ? 0 : deadline - this.visitStart;
    const pageDur = this.pageStart === null ? 0 : deadline - this.pageStart;
    const durationMs = chunk >= 1 ? chunk : null;
    const page =
      pageDur >= 1 && this.pageStart !== null
        ? { pageNumber: this.page, enteredAtMs: this.pageStart, leftAtMs: deadline, pageDurationMs: pageDur }
        : null;
    if (durationMs !== null || page !== null) out.push({ reason: "idle", durationMs, page });
    this.isIdle = true;
    this.visitStart = null;
    this.pageStart = null;
    this.lastFlushAt = deadline;
    return out;
  }

  input(now: number): void {
    this.lastInputAt = now;
    if (this.isIdle && !this.isHidden && !this.isStopped) {
      this.isIdle = false;
      this.visitStart = now;
      this.pageStart = now;
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
      }
      return idleFlushes;
    }
    const pageStart = this.pageStart ?? now;
    const pageDur = now - pageStart;
    const chunk = now - (this.visitStart ?? now);
    this.visitStart = now;
    this.lastFlushAt = now;
    const out: Flush[] = [];
    if (pageDur >= MIN_CHUNK_MS) {
      out.push({
        reason: "turn",
        durationMs: chunk >= 1 ? chunk : null,
        page: { pageNumber: this.page, enteredAtMs: pageStart, leftAtMs: now, pageDurationMs: pageDur },
        toPage,
      });
    }
    this.page = toPage;
    this.pageStart = now;
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
    this.visitStart = now;
    this.lastFlushAt = now;
    return [{ reason: "heartbeat", durationMs: chunk, page: null }];
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
    const pageDur = this.pageStart === null ? 0 : now - this.pageStart;
    const durationMs = chunk >= 1 ? chunk : null;
    const page =
      pageDur >= 1 && this.pageStart !== null
        ? { pageNumber: this.page, enteredAtMs: this.pageStart, leftAtMs: now, pageDurationMs: pageDur }
        : null;
    if (durationMs !== null || page !== null) out.push({ reason, durationMs, page });
    this.visitStart = null;
    this.pageStart = null;
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
          enteredAtMs: Math.floor(f.page.enteredAtMs),
          leftAtMs: Math.floor(f.page.leftAtMs),
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
