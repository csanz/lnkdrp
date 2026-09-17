/**
 * Turn a planned visit into the exact requests a browser would send, by driving the viewer's real
 * `ReadingClock` in virtual time: load → inputs every 10-60s → heartbeat every 30s and idle tick
 * every 5s → turn (+ nav seen POST on the first reach of a page) → hidden/visible or idle for
 * injections → pagehide (skipped when the tab is killed).
 *
 * `compileVisit` is pure; `sendRequests` does the network part.
 */
import {
  buildSeenPayload,
  buildTimingPayload,
  HEARTBEAT_MS,
  IDLE_CHECK_MS,
  ReadingClock,
  type Flush,
} from "@/lib/share/readingClock";

import { getDownload, postStats, sleep, type PublicCallOpts } from "./api";
import { mulberry32 } from "./content";
import type { PlannedPerson, PlannedVisit } from "./plan";

export type WireRequest = {
  method: "POST" | "GET";
  path: string;
  /** Virtual time the browser would have sent it. */
  atMs: number;
  body: Record<string, unknown> | null;
  kind: "seen" | "timing" | "download";
};

export type CompiledVisit = { requests: WireRequest[]; lastRequestAt: number; endAt: number };

export function statsPath(shareId: string): string {
  return `/api/share/${encodeURIComponent(shareId)}/stats`;
}

export function downloadPath(shareId: string, botId: string): string {
  return `/s/${encodeURIComponent(shareId)}/pdf?download=1&botId=${encodeURIComponent(botId)}`;
}

export function compileVisit(
  v: PlannedVisit,
  ctx: { botId: string; shareId: string; numPages: number; intro: PlannedPerson["intro"]; startAt?: number },
): CompiledVisit {
  const r = mulberry32(v.rngSeed);
  const inputGap = () => 10_000 + Math.floor(r() * 50_001);
  const path = statsPath(ctx.shareId);
  const intro = ctx.intro ?? {};
  const requests: WireRequest[] = [];
  const push = (atMs: number, body: Record<string, unknown>, kind: WireRequest["kind"]) =>
    requests.push({ method: "POST", path, atMs, body: { ...body, ...intro }, kind });
  const emit = (atMs: number, flushes: Flush[]) => {
    for (const f of flushes) push(atMs, buildTimingPayload(f, { botId: ctx.botId, visitId: v.visitId, numPages: ctx.numPages }), "timing");
  };

  let t = ctx.startAt ?? v.startAt;
  const first = v.stops[0]!;
  const clock = new ReadingClock({ now: t, page: first.page });
  push(t, buildSeenPayload({ botId: ctx.botId, visitId: v.visitId, pageNumber: first.page, numPages: ctx.numPages }), "seen");
  const reached = new Set([first.page]);
  let nextHeartbeat = t + HEARTBEAT_MS;
  let nextTick = t + IDLE_CHECK_MS;
  let nextInput = t + inputGap();

  // Periodic events strictly before `until`, in time order (input, then tick, then heartbeat on ties).
  const runUntil = (until: number, inputs: boolean) => {
    for (;;) {
      const inputAt = inputs ? nextInput : Number.POSITIVE_INFINITY;
      const at = Math.min(inputAt, nextTick, nextHeartbeat);
      if (at >= until) break;
      if (at === inputAt) {
        clock.input(at);
        nextInput = at + inputGap();
      } else if (at === nextTick) {
        emit(at, clock.tick(at));
        nextTick += IDLE_CHECK_MS;
      } else {
        emit(at, clock.heartbeat(at));
        nextHeartbeat += HEARTBEAT_MS;
      }
    }
  };

  v.stops.forEach((stop, i) => {
    let remaining = stop.ms;
    if (v.hiddenSplit && v.hiddenSplit.stopIndex === i) {
      runUntil(t + v.hiddenSplit.afterMs, true);
      t += v.hiddenSplit.afterMs;
      emit(t, clock.hidden(t));
      runUntil(t + v.hiddenSplit.gapMs, false);
      t += v.hiddenSplit.gapMs;
      clock.visible(t);
      nextInput = t + inputGap();
      remaining -= v.hiddenSplit.afterMs;
    } else if (v.idle && v.idle.stopIndex === i) {
      runUntil(t + v.idle.afterMs, true);
      t += v.idle.afterMs;
      clock.input(t);
      runUntil(t + v.idle.idleMs, false);
      t += v.idle.idleMs;
      clock.input(t);
      nextInput = t + inputGap();
      remaining -= v.idle.afterMs;
    }
    runUntil(t + remaining, true);
    t += remaining;
    const next = v.stops[i + 1];
    if (next) {
      emit(t, clock.turn(t, next.page));
      nextInput = t + inputGap();
      if (!reached.has(next.page)) {
        reached.add(next.page);
        push(t, buildSeenPayload({ botId: ctx.botId, visitId: v.visitId, pageNumber: next.page, numPages: ctx.numPages }), "seen");
      }
    } else if (!v.killed) {
      emit(t, clock.pagehide(t));
    }
  });

  const lastRequestAt = requests.length ? requests[requests.length - 1]!.atMs : t;
  return { requests, lastRequestAt, endAt: t };
}

/** Every request of a person, visits in order, then the download (if planned). */
export function compilePerson(person: PlannedPerson, numPages: number): WireRequest[][] {
  const out = person.visits.map(
    (v) => compileVisit(v, { botId: person.botId, shareId: person.shareId, numPages, intro: person.intro }).requests,
  );
  if (person.download) {
    out.push([
      { method: "GET", path: downloadPath(person.shareId, person.botId), atMs: person.download.atMs, body: null, kind: "download" },
    ]);
  }
  return out;
}

export type SendResult = { sent: number; refused: boolean; failures: number };

/**
 * Send one visit's requests in order, one at a time, with a jittered gap between them.
 * A 404 on the first request means the link refuses views; nothing else is sent.
 */
export async function sendRequests(
  requests: WireRequest[],
  opts: PublicCallOpts & { postGapMs: [number, number] },
): Promise<SendResult> {
  let sent = 0;
  let failures = 0;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    if (i > 0) await sleep(opts.postGapMs[0] + Math.random() * (opts.postGapMs[1] - opts.postGapMs[0]));
    const status =
      req.method === "GET" ? await getDownload(req.path, opts) : await postStats(req.path, req.body ?? {}, opts);
    if (status === 404 && i === 0) return { sent, refused: true, failures };
    if (status >= 400) failures += 1;
    else sent += 1;
  }
  return { sent, refused: false, failures };
}
