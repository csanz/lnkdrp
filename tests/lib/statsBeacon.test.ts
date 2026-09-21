/**
 * A limiter should shed load, never eat data.
 *
 * The viewer posted its reading measurements with `void fetch(...).catch(() => void 0)`. It never
 * read the status, and `ReadingClock` clears its ledger the moment it hands a flush over, so
 * anything the server did not accept was destroyed rather than delayed.
 *
 * That was survivable while the ingest always answered 200. It stopped being survivable the day a
 * rate limiter went in front of it keyed on the caller's address: a data room opened by one deal
 * team behind one corporate egress shares a bucket, and what the 429 took was not an attacker's
 * spam but the reading time of the people the deck was sent to. The owner saw analytics that were
 * quietly wrong for exactly the audiences who read it together.
 *
 * Both halves were fixed. The key is per reader now, and this is the other half: a refusal that
 * means "not now" is tried again.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createStatsBeacon, shouldRetryStatus } from "@/lib/share/statsBeacon";

const URL_ = "/api/share/abc/stats";

function res(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what counts as try again", () => {
  test("429 and 5xx are not final", () => {
    expect(shouldRetryStatus(429)).toBe(true);
    expect(shouldRetryStatus(500)).toBe(true);
    expect(shouldRetryStatus(503)).toBe(true);
  });

  test("an ordinary 4xx is final", () => {
    // A 400 is a payload this build will never get right; a 404 is a link that stopped existing.
    // Retrying either is noise on somebody else's server.
    for (const s of [400, 401, 403, 404, 410]) expect(shouldRetryStatus(s)).toBe(false);
  });
});

describe("the beacon", () => {
  test("a 200 is sent once and forgotten", async () => {
    const post = vi.fn(async () => res(200));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send('{"a":1}');
    await vi.advanceTimersByTimeAsync(0);

    expect(post).toHaveBeenCalledTimes(1);
    expect(beacon.pendingCount()).toBe(0);
  });

  test("a 429 is retried, and the reading survives", async () => {
    // The whole point. Before, this measurement was gone the moment the server said no.
    const post = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValue(res(200));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send('{"pageTimeMs":8000}');
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toBe('{"pageTimeMs":8000}');
    expect(beacon.pendingCount()).toBe(0);
  });

  test("a network failure is retried too", async () => {
    // Offline for a moment is the common case in a viewer, not an error worth discarding data for.
    const post = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(res(200));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send("{}");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(post).toHaveBeenCalledTimes(2);
  });

  test("a 400 is not retried", async () => {
    const post = vi.fn(async () => res(400));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send("{}");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(post).toHaveBeenCalledTimes(1);
    expect(beacon.pendingCount()).toBe(0);
  });

  test("attempts are bounded, so a dead server is not retried forever", async () => {
    const post = vi.fn(async () => res(429));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send("{}");
    await vi.advanceTimersByTimeAsync(120_000);

    // One send plus the three backoff steps, then it stops.
    expect(post).toHaveBeenCalledTimes(4);
    expect(beacon.pendingCount()).toBe(0);
  });

  test("every attempt keeps `keepalive`, because the last flush happens during pagehide", async () => {
    const post = vi.fn(async () => res(200));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send("{}");
    await vi.advanceTimersByTimeAsync(0);

    expect((post.mock.calls[0]?.[1] as RequestInit)?.keepalive).toBe(true);
  });

  test("the queue is capped, and it is the oldest that goes", async () => {
    // A reader who has been offline for ten minutes should reconnect with their recent reading
    // intact, not replay a thousand stale chunks at a server that is already struggling.
    const post = vi.fn(async () => res(429));
    const beacon = createStatsBeacon(URL_, post);

    for (let i = 0; i < 20; i += 1) beacon.send(`{"n":${i}}`);
    await vi.advanceTimersByTimeAsync(0);

    expect(beacon.pendingCount()).toBeLessThanOrEqual(12);
  });

  test("stop() releases the timers, so a closed tab retries nothing", async () => {
    const post = vi.fn(async () => res(429));
    const beacon = createStatsBeacon(URL_, post);

    beacon.send("{}");
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);

    beacon.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(post).toHaveBeenCalledTimes(1);
    expect(beacon.pendingCount()).toBe(0);
  });

  test("retries are jittered, so a roomful of readers do not resynchronise", async () => {
    // Without jitter every reader refused at the same instant comes back at the same instant and
    // trips the same limit again.
    const waits = new Set<number>();
    for (let run = 0; run < 8; run += 1) {
      const post = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValue(res(200));
      const beacon = createStatsBeacon(URL_, post);
      beacon.send("{}");
      await vi.advanceTimersByTimeAsync(0);
      let waited = 0;
      while (post.mock.calls.length < 2 && waited < 10_000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.add(waited);
      beacon.stop();
    }
    expect(waits.size).toBeGreaterThan(1);
  });
});
