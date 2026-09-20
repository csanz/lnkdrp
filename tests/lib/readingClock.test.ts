import { describe, expect, test } from "vitest";

import {
  buildSeenPayload,
  buildTimingPayload,
  IDLE_AFTER_MS,
  ReadingClock,
  type Flush,
} from "@/lib/share/readingClock";

const S = 1_000_000;

function clock(page = 1) {
  return new ReadingClock({ now: S, page });
}

describe("ReadingClock", () => {
  test("(a) a turn after 5s flushes both clocks and names the next page", () => {
    const c = clock();
    const out = c.turn(S + 5000, 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: "turn", durationMs: 5000, toPage: 2 });
    expect(out[0].page).toEqual({ pageNumber: 1, enteredAtMs: S, leftAtMs: S + 5000, pageDurationMs: 5000, exit: true });
    expect(c.snapshot().page).toBe(2);
  });

  test("(b) a flip under 1.5s sends nothing and restarts both clocks", () => {
    const c = clock();
    expect(c.turn(S + 1000, 2)).toEqual([]);
    const out = c.turn(S + 4000, 3);
    expect(out).toHaveLength(1);
    expect(out[0].durationMs).toBe(3000);
    expect(out[0].page).toMatchObject({ pageNumber: 2, pageDurationMs: 3000 });
  });

  test("(c) a heartbeat reports the page it is still on, and the turn sends only what is left", () => {
    // The reason this changed: on a one-page document the page clock used to move only when the
    // page did, so nothing was ever recorded until the tab closed. Now the heartbeat carries it —
    // marked as not an exit — and the ledger keeps the turn from sending those seconds twice.
    const c = clock();
    const hb = c.heartbeat(S + 30_000);
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ reason: "heartbeat", durationMs: 30_000 });
    expect(hb[0].page).toEqual({
      pageNumber: 1,
      enteredAtMs: S,
      leftAtMs: S + 30_000,
      pageDurationMs: 30_000,
      exit: false,
    });
    const out = c.turn(S + 40_000, 2);
    expect(out[0].durationMs).toBe(10_000);
    // 40s on the page, 30s of it already reported by the heartbeat.
    expect(out[0].page?.pageDurationMs).toBe(10_000);
    expect(out[0].page?.exit).toBe(true);
  });

  test("(c2) a one-page document accrues page time without ever turning a page", () => {
    const c = clock();
    let reported = 0;
    for (let t = 30_000; t <= 120_000; t += 30_000) {
      c.input(S + t - 1);
      for (const f of c.heartbeat(S + t)) reported += f.page?.pageDurationMs ?? 0;
    }
    // Two minutes of reading, two minutes credited to page 1 — before the tab is ever closed.
    expect(reported).toBe(120_000);
    // And the close adds only the tail, not the two minutes again.
    const out = c.pagehide(S + 125_000);
    expect(out[0].page?.pageDurationMs).toBe(5000);
  });

  test("(d) heartbeat anti-storm and minimum chunk guards", () => {
    const c = clock();
    c.turn(S + 5000, 2);
    expect(c.heartbeat(S + 5500)).toEqual([]);
    expect(c.snapshot().visitStart).toBe(S + 5000);
    expect(c.heartbeat(S + 6300)).toEqual([]);
    expect(c.snapshot().visitStart).toBe(S + 5000);
  });

  test("(e) hidden right after a turn still sends the short segment; pagehide after it sends nothing", () => {
    const c = clock();
    c.turn(S + 5000, 2);
    const out = c.hidden(S + 5700);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: "hidden", durationMs: 700 });
    expect(out[0].page).toEqual({ pageNumber: 2, enteredAtMs: S + 5000, leftAtMs: S + 5700, pageDurationMs: 700, exit: true });
    expect(c.pagehide(S + 5750)).toEqual([]);
    expect(c.unmount(S + 5800)).toEqual([]);
  });

  test("(f) pagehide 300ms after a heartbeat sends the tail of both clocks, not the whole page again", () => {
    const c = clock();
    c.heartbeat(S + 30_000);
    const out = c.pagehide(S + 30_300);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: "pagehide", durationMs: 300 });
    // The bounds still describe the whole stay — they are what the server reads as the exit — but
    // the clock carries only the 300ms the heartbeat had not already sent.
    expect(out[0].page).toEqual({ pageNumber: 1, enteredAtMs: S, leftAtMs: S + 30_300, pageDurationMs: 300, exit: true });
  });

  test("(g) idle ends the segment five minutes after the last input", () => {
    const c = clock();
    expect(c.tick(S + 300_000)).toEqual([]);
    const out = c.tick(S + 305_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: "idle", durationMs: 300_000 });
    expect(out[0].page).toEqual({ pageNumber: 1, enteredAtMs: S, leftAtMs: S + 300_000, pageDurationMs: 300_000, exit: true });
    expect(c.heartbeat(S + 330_000)).toEqual([]);
    expect(c.snapshot().idle).toBe(true);
  });

  test("(h) input after idle restarts the clocks from that input", () => {
    const c = clock();
    c.tick(S + 305_000);
    c.input(S + 400_000);
    const out = c.turn(S + 410_000, 3);
    expect(out).toHaveLength(1);
    expect(out[0].page?.pageDurationMs).toBe(10_000);
    expect(out[0].durationMs).toBe(10_000);
  });

  test("(i) visible resets the idle timer", () => {
    const c = clock();
    c.hidden(S + 10_000);
    c.visible(S + 900_000);
    expect(c.tick(S + 905_000)).toEqual([]);
  });

  test("(j) heartbeats without input: the idle flush ends at the deadline with no visit chunk left", () => {
    const c = clock();
    for (let t = 30_000; t < 300_000; t += 30_000) {
      expect(c.heartbeat(S + t)).toHaveLength(1);
    }
    const at300 = c.heartbeat(S + 300_000);
    expect(at300).toHaveLength(1);
    expect(at300[0]).toMatchObject({ reason: "heartbeat", durationMs: 30_000 });
    // The idle cut-off still fires, and now has nothing left to say: the heartbeats carried every
    // one of those five minutes as they passed, and the ledger will not send them again. An empty
    // flush list is the honest answer, and the clock is idle either way.
    const at330 = c.heartbeat(S + 330_000);
    expect(at330).toEqual([]);
    expect(c.snapshot().idle).toBe(true);
  });

  test("(k) fuzz: no empty or inverted intervals, page time never exceeds visit time", () => {
    function mulberry32(seed: number) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      let now = S;
      const c = new ReadingClock({ now, page: 1 });
      const flushes: Flush[] = [];
      const steps = 10 + Math.floor(rnd() * 60);
      for (let i = 0; i < steps; i++) {
        const r = rnd();
        now += r < 0.1 ? Math.floor(rnd() * 400_000) : r < 0.2 ? 0 : Math.floor(rnd() * 20_000);
        const op = Math.floor(rnd() * 8);
        if (op === 0) c.input(now);
        else if (op === 1) flushes.push(...c.turn(now, 1 + Math.floor(rnd() * 12)));
        else if (op === 2) flushes.push(...c.heartbeat(now));
        else if (op === 3) flushes.push(...c.tick(now));
        else if (op === 4) flushes.push(...c.hidden(now));
        else if (op === 5) c.visible(now);
        else if (op === 6 && rnd() < 0.2) flushes.push(...c.pagehide(now));
        else if (op === 7 && rnd() < 0.1) flushes.push(...c.unmount(now));
      }
      flushes.push(...c.unmount(now + Math.floor(rnd() * 5000)));
      let visit = 0;
      let page = 0;
      for (const f of flushes) {
        expect(f.durationMs === null || f.durationMs >= 1).toBe(true);
        if (f.durationMs) visit += f.durationMs;
        if (f.page) {
          expect(f.page.pageDurationMs).toBeGreaterThanOrEqual(1);
          expect(f.page.enteredAtMs).toBeLessThan(f.page.leftAtMs);
          page += f.page.pageDurationMs;
        }
        expect(f.durationMs !== null || f.page !== null).toBe(true);
      }
      expect(page).toBeLessThanOrEqual(visit);
    }
  });

  test("hidden, pagehide, unmount in browser order produce exactly one flush", () => {
    const c = clock();
    const all = [...c.hidden(S + 8000), ...c.pagehide(S + 8001), ...c.unmount(S + 8002)];
    expect(all.map((f) => f.reason)).toEqual(["hidden"]);
  });

  test("idle deadline uses IDLE_AFTER_MS", () => {
    expect(IDLE_AFTER_MS).toBe(300_000);
  });
});

describe("payloads", () => {
  test("(l) timing payload key sets", () => {
    const ctx = { botId: "b1", visitId: "v1", numPages: 4 };
    const turn = buildTimingPayload(
      { reason: "turn", durationMs: 5000.7, page: { pageNumber: 1, enteredAtMs: S, leftAtMs: S + 5000, pageDurationMs: 5000, exit: true }, toPage: 2 },
      ctx,
    );
    expect(Object.keys(turn).sort()).toEqual(
      ["botId", "visitId", "tv", "reason", "numPages", "durationMs", "pageNumber", "pageDurationMs", "enteredAtMs", "leftAtMs", "toPage"].sort(),
    );
    expect(turn).toMatchObject({ tv: 2, reason: "turn", durationMs: 5000, toPage: 2, numPages: 4 });

    const hb = buildTimingPayload({ reason: "heartbeat", durationMs: 30_000, page: null }, { ...ctx, numPages: null });
    expect(Object.keys(hb).sort()).toEqual(["botId", "durationMs", "reason", "tv", "visitId"]);

    // A heartbeat that carries the page it is still on sends the clock and not the bounds: bounds
    // are what the server reads as "they left" (`isPageExit`), and they have not.
    const hbPage = buildTimingPayload(
      {
        reason: "heartbeat",
        durationMs: 30_000,
        page: { pageNumber: 1, enteredAtMs: S, leftAtMs: S + 30_000, pageDurationMs: 30_000, exit: false },
      },
      { ...ctx, numPages: null },
    );
    expect(Object.keys(hbPage).sort()).toEqual(
      ["botId", "durationMs", "pageDurationMs", "pageNumber", "reason", "tv", "visitId"].sort(),
    );

    const idle = buildTimingPayload(
      { reason: "idle", durationMs: null, page: { pageNumber: 3, enteredAtMs: S, leftAtMs: S + 300_000, pageDurationMs: 300_000, exit: true } },
      ctx,
    );
    expect(Object.keys(idle).sort()).toEqual(
      ["botId", "enteredAtMs", "leftAtMs", "numPages", "pageDurationMs", "pageNumber", "reason", "tv", "visitId"].sort(),
    );
  });

  test("(l) seen payload key sets", () => {
    expect(Object.keys(buildSeenPayload({ botId: "b", visitId: "v", pageNumber: 2, numPages: 4 })).sort()).toEqual(
      ["botId", "numPages", "pageNumber", "tv", "visitId"].sort(),
    );
    expect(buildSeenPayload({ botId: "b", visitId: null, pageNumber: 1, numPages: null })).toEqual({
      botId: "b",
      pageNumber: 1,
      tv: 2,
    });
  });
});
