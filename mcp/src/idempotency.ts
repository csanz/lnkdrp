/**
 * In-memory idempotency cache for write tools.
 *
 * Keyed by `${orgId}:${tool}:${idempotencyKey}`; a replay within the TTL returns the stored result
 * (or joins the in-flight promise) instead of running the write again. Failed runs are evicted so
 * a retry after an error re-executes. Bounded by dropping the oldest entries.
 */
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "./config";

type Entry = { promise: Promise<unknown>; expiresAt: number };

/** Bounded, TTL-limited map of idempotency key to result promise. */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.max = opts.max ?? IDEMPOTENCY_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Build the cache key for a workspace + tool + caller-supplied key. */
  static key(orgId: string, tool: string, idempotencyKey: string): string {
    return `${orgId}:${tool}:${idempotencyKey}`;
  }

  /**
   * Run `fn` once per key: a replay returns the cached value with `replayed: true`. Concurrent
   * calls with the same key share one execution.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return { value: (await existing.promise) as T, replayed: true };
    }
    if (existing) this.entries.delete(key);

    const promise = fn();
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });
    this.trim();
    try {
      const value = await promise;
      return { value, replayed: false };
    } catch (err) {
      // A failed write must not be "remembered": the next attempt with the same key runs again.
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
      throw err;
    }
  }

  /** Drop expired entries (called by the session sweeper). */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private trim(): void {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
