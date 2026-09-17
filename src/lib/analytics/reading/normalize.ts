import { STOP_CAP_MS } from "./constants";
import type { NormalizedVisit, RawPageEvent, Stop, VisitInput } from "./types";

export type { NormalizedVisit, Stop } from "./types";

/** Epoch ms for a Date or date string; null when missing or unparseable. */
export function toMs(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function isPageInRange(v: unknown, P: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= P;
}

type TimedEvent = {
  page: number;
  durationMs: number;
  enteredAtMs: number;
  leftAtMs: number;
  reason: string | null;
  toPage: number | null;
  index: number;
};

function timedEvent(ev: RawPageEvent, index: number, P: number): TimedEvent | null {
  if (!ev || !isPageInRange(ev.pageNumber, P)) return null;
  const d = ev.durationMs;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return null;
  const enteredAtMs = toMs(ev.enteredAt);
  const leftAtMs = toMs(ev.leftAt);
  if (enteredAtMs === null || leftAtMs === null) return null;
  const reason = ev.reason ?? null;
  const toPage = reason === "turn" && isPageInRange(ev.toPage, P) && ev.toPage !== ev.pageNumber ? ev.toPage : null;
  return { page: ev.pageNumber, durationMs: d, enteredAtMs, leftAtMs, reason, toPage, index };
}

/**
 * Turn one ShareVisit into stops, per-page dwell, seen pages and the exit page for a document of P
 * pages. Events outside 1..P or without a usable duration and timestamps are dropped and counted.
 */
export function normalizeVisit(v: VisitInput, P: number): NormalizedVisit {
  const raw = Array.isArray(v.pageEvents) ? v.pageEvents : [];
  const events: TimedEvent[] = [];
  raw.forEach((ev, i) => {
    const t = timedEvent(ev, i, P);
    if (t) events.push(t);
  });
  events.sort((a, b) => a.enteredAtMs - b.enteredAtMs || a.leftAtMs - b.leftAtMs || a.index - b.index);

  // A tv2 hidden/idle/heartbeat split continues the same stop; only a "turn" ends one. Legacy events
  // carry no reason, so they merge by adjacency alone.
  type Acc = { page: number; sum: number; reason: string | null; toPage: number | null };
  const acc: Acc[] = [];
  let cur: Acc | null = null;
  let prevReason: string | null = null;
  for (const ev of events) {
    if (cur && ev.page === cur.page && prevReason !== "turn") {
      cur.sum += ev.durationMs;
      cur.reason = ev.reason;
      cur.toPage = ev.toPage;
    } else {
      cur = { page: ev.page, sum: ev.durationMs, reason: ev.reason, toPage: ev.toPage };
      acc.push(cur);
    }
    prevReason = ev.reason;
  }

  const dwellByPage = new Array<number>(Math.max(0, P)).fill(0);
  const stopsByPage = new Array<number>(Math.max(0, P)).fill(0);
  const stops: Stop[] = acc.map((s) => {
    const revisit = stopsByPage[s.page - 1] > 0;
    const ms = Math.min(STOP_CAP_MS, s.sum);
    dwellByPage[s.page - 1] += ms;
    stopsByPage[s.page - 1] += 1;
    return { page: s.page, ms, revisit, reason: s.reason, toPage: s.toPage };
  });

  const seenSet = new Set<number>();
  for (const p of Array.isArray(v.pagesSeen) ? v.pagesSeen : []) {
    if (isPageInRange(p, P)) seenSet.add(p);
  }
  for (const ev of events) seenSet.add(ev.page);
  const seen = [...seenSet].sort((a, b) => a - b);

  const timeSpentMs = typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) && v.timeSpentMs > 0 ? v.timeSpentMs : 0;
  const startedAtMs = toMs(v.startedAt) ?? 0;
  const lastEventAtMs = toMs(v.lastEventAt) ?? startedAtMs;

  let exitPage: number | null = null;
  let exitInferred = false;
  let untimedTail: number[] = [];
  if (events.length > 0) {
    let best = events[0];
    for (const ev of events) if (ev.leftAtMs >= best.leftAtMs) best = ev;
    // A visit whose last timed event is a turn lost its final flush (e.g. a killed tab): the person
    // demonstrably arrived on the turn's target, and any later page seen without a timed event (or an
    // earlier turn landing on it) was flipped to after it. Activity after that turn means they got as
    // far as the last such page.
    if (best.toPage !== null && seenSet.has(best.toPage)) {
      const target = best.toPage;
      const earlierTargets = new Set(events.filter((ev) => ev !== best && ev.toPage !== null).map((ev) => ev.toPage));
      untimedTail = seen.filter((p) => p === target || (p > target && stopsByPage[p - 1] === 0 && !earlierTargets.has(p)));
      exitPage = lastEventAtMs > best.leftAtMs ? untimedTail[untimedTail.length - 1] : target;
      exitInferred = true;
    } else {
      exitPage = best.page;
    }
  } else if (seen.length > 0) {
    exitPage = seen[seen.length - 1];
    exitInferred = true;
  }

  return {
    visitId: String(v.visitId),
    shareId: String(v.shareId),
    botIdHash: String(v.botIdHash),
    startedAtMs,
    lastEventAtMs,
    timeSpentMs,
    timed: events.length > 0,
    seen,
    dwellByPage,
    stopsByPage,
    stops,
    exitPage,
    exitInferred,
    untimedTail,
    droppedEvents: raw.length - events.length,
    tv2: v.timingVersion === 2,
  };
}
