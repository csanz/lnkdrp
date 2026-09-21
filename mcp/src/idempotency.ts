/**
 * In-memory idempotency cache for write tools.
 *
 * Keyed by `${orgId}:${tool}:${idempotencyKey}`; a replay within the TTL returns the stored result
 * (or joins the in-flight promise) instead of running the write again. Failed runs are evicted so
 * a retry after an error re-executes. Bounded by dropping the oldest entries.
 */
import { createHash } from "node:crypto";

import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "./config";
import { ToolError } from "./errors";

type Entry = { promise: Promise<unknown>; expiresAt: number; fingerprint?: string | undefined };

/**
 * A stable hash of a call's arguments, without the idempotency key itself. Large fields (a PDF's
 * base64) are hashed like everything else, so the fingerprint stays small.
 */
export function fingerprintArgs(args: Record<string, unknown>): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  const { idempotencyKey: _key, ...rest } = args;
  void _key;
  return createHash("sha256").update(JSON.stringify(stable(rest))).digest("hex");
}

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
  async run<T>(
    key: string,
    fn: () => Promise<T>,
    opts: {
      fingerprint?: string;
      /**
       * Does the thing this key created still exist?
       *
       * Without it a replay outlives its subject: create a document, delete it, retry the key, and
       * the tool answers with the original success — same docId, `status: "ready"`, no warning —
       * describing something that is gone. The agent hands a dead share link to a human. The cache
       * cannot know that on its own, because only the caller knows what the stored value points at
       * and how to look it up, so the caller says.
       *
       * Treated as "still there" when it throws: a lookup that failed for its own reasons is not
       * evidence of a deletion, and re-running a create on a bad network call is the one outcome
       * worse than a stale replay.
       */
      stillExists?: (value: T) => Promise<boolean>;
    } = {},
  ): Promise<{ value: T; replayed: boolean }> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Same key, different arguments: returning the stored result would tell the agent its new
      // file/title/settings were applied when they were silently ignored.
      if (opts.fingerprint && existing.fingerprint && opts.fingerprint !== existing.fingerprint) {
        throw new ToolError(
          "validation",
          "This idempotencyKey was already used with different arguments, so nothing new was done. " +
            "Use a new idempotencyKey for a different request, or repeat the original arguments exactly to get the stored result.",
          { status: 409, details: { code: "idempotency_key_reused" } },
        );
      }
      const cached = (await existing.promise) as T;
      if (opts.stillExists) {
        const alive = await opts.stillExists(cached).catch(() => true);
        if (!alive) {
          // Gone. Forget the key and fall through to a real run, which is what the caller asked
          // for: "give me this thing", not "tell me what I once made".
          this.entries.delete(key);
          return this.run(key, fn, opts);
        }
      }
      return { value: cached, replayed: true };
    }
    if (existing) this.entries.delete(key);

    const promise = fn();
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs, fingerprint: opts.fingerprint });
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
