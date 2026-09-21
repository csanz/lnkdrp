/**
 * Posting a reading measurement, with the one property the old call site did not have: a refusal
 * that means "try again" is tried again.
 *
 * The viewer used to post `void fetch(...).catch(() => void 0)`. It never read the status, and
 * `ReadingClock` clears its ledger the moment it hands a flush over — so anything the server did not
 * accept was not delayed, it was destroyed. Page dwell, exit page and the whole of that chunk's
 * reading time, gone, with nothing logged anywhere.
 *
 * That was survivable while the endpoint always answered 200. It stopped being survivable when a
 * rate limiter went in front of it: the limiter is keyed per address, a real audience opens a data
 * room from one corporate egress, and what a 429 took was not an attacker's spam but the reading
 * time of the people the deck was sent to. The owner sees analytics that are quietly wrong for
 * exactly the audiences who read it together, which reads as a broken product rather than a limit.
 *
 * A limiter should shed load, never eat data. So:
 *
 * - **429 and 5xx are retried** with backoff and jitter. Those mean "not now".
 * - **4xx other than 429 is not.** A 400 is a payload this build will never get right, and a 404 is
 *   a link that stopped existing; retrying either is just noise on someone else's server.
 * - **A network error is retried**, because offline-for-a-moment is the common case in a viewer.
 * - **Attempts are bounded** and the queue is capped, because a reader who has been offline for ten
 *   minutes should reconnect with their recent reading intact, not replay a thousand stale chunks.
 *
 * `keepalive` is kept on every attempt: the last flush of a session happens during `pagehide`, and
 * without it the browser cancels the request as the tab goes away. It caps the body at 64KB, which
 * these payloads are nowhere near.
 */

/** Wait between attempts. Jittered so a roomful of readers behind one address do not resynchronise. */
const BACKOFF_MS = [2_000, 6_000, 15_000] as const;

/**
 * How many payloads may be waiting at once.
 *
 * Small on purpose. Reading time that is minutes stale is worth keeping; a backlog big enough to
 * matter means something is wrong that a retry will not fix, and replaying it would hand the server
 * a burst at the moment it is least able to take one.
 */
const MAX_PENDING = 12;

type Pending = { body: string; attempt: number; timer: ReturnType<typeof setTimeout> | null };

export type StatsBeaconPoster = (body: string, init: RequestInit) => Promise<Response>;

/** Should this answer be tried again, or is it final? */
export function shouldRetryStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * A per-viewer sender. One instance per mounted viewer; `stop()` on unmount so a closed tab stops
 * holding timers.
 */
export function createStatsBeacon(url: string, post: StatsBeaconPoster) {
  const pending = new Set<Pending>();
  let stopped = false;

  function drop(item: Pending) {
    if (item.timer) clearTimeout(item.timer);
    pending.delete(item);
  }

  function schedule(item: Pending) {
    const base = BACKOFF_MS[Math.min(item.attempt, BACKOFF_MS.length - 1)]!;
    // Up to +50%, so simultaneous readers spread out instead of retrying in lockstep and
    // re-triggering the same limit that refused them.
    const wait = base + Math.floor(Math.random() * base * 0.5);
    item.timer = setTimeout(() => {
      item.timer = null;
      void attempt(item);
    }, wait);
  }

  async function attempt(item: Pending): Promise<void> {
    if (stopped) return;
    let res: Response | null = null;
    try {
      res = await post(item.body, {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: item.body,
      });
    } catch {
      // Network-level failure: offline, DNS, a tab being torn down. Worth another go.
      res = null;
    }

    if (res && res.ok) {
      drop(item);
      return;
    }
    const retryable = res ? shouldRetryStatus(res.status) : true;
    if (!retryable || item.attempt >= BACKOFF_MS.length) {
      // Out of attempts, or an answer that will never change. Dropping here is the honest end of
      // the line rather than a silent one at the start of it.
      drop(item);
      return;
    }
    // Scheduled on the current attempt number, then incremented: waiting the *second* delay before
    // the first retry is an easy off-by-one and it makes a 429 feel like a stall.
    schedule(item);
    item.attempt += 1;
  }

  return {
    /** Send one payload. Returns immediately; retries happen on their own. */
    send(body: string): void {
      if (stopped) return;
      if (pending.size >= MAX_PENDING) {
        // Shed the oldest: the newest measurement is the one most likely to still be true.
        const oldest = pending.values().next().value;
        if (oldest) drop(oldest);
      }
      const item: Pending = { body, attempt: 0, timer: null };
      pending.add(item);
      void attempt(item);
    },
    /** Stop retrying and release timers. */
    stop(): void {
      stopped = true;
      for (const item of [...pending]) drop(item);
    },
    /** For tests. */
    pendingCount(): number {
      return pending.size;
    },
  };
}
