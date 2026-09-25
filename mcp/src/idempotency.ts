/**
 * In-memory idempotency cache for write tools.
 *
 * Keyed by `${orgId}:${credentialId}:${tool}:${idempotencyKey}`; a replay within the TTL returns
 * the stored result (or joins the in-flight promise) instead of running the write again. Failed
 * runs are evicted so a retry after an error re-executes. Bounded per credential and globally by
 * dropping the oldest entries.
 *
 * The credential is in the key on purpose: two keys of one workspace choosing the same
 * `idempotencyKey` are two callers, and one replaying the other's result would hand it a document
 * it never made. The cap is per credential for the same reason (see `IDEMPOTENCY_MAX_PER_CREDENTIAL`).
 */
import { createHash } from "node:crypto";

import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_MAX_PER_CREDENTIAL, IDEMPOTENCY_TTL_MS } from "./config";
import { ToolError } from "./errors";

type Entry = { promise: Promise<unknown>; expiresAt: number; fingerprint?: string | undefined; scope: string };

/**
 * Arguments that say how long the caller will wait, not what they are asking for.
 *
 * These are deliberately outside the fingerprint. The retry this whole mechanism exists for is
 * "the first call timed out waiting, ask again" — and the natural second call drops `waitForReady`
 * so it returns at once. Hashing them made that the one retry the store refuses: same key, same
 * document, same file, `idempotency_key_reused`. A caller who did exactly the right thing was told
 * they had asked for something different.
 */
const WAIT_ARGS = new Set(["waitForReady", "timeoutSeconds"]);

/**
 * A stable hash of a call's arguments: the idempotency key itself and the wait options are left
 * out, everything else is in. Large fields (a PDF's base64) are hashed like anything else, so the
 * fingerprint stays small.
 *
 * `optimize` stays in on purpose - it changes the bytes that get uploaded, so two calls that
 * disagree about it are asking for different things.
 */
export function fingerprintArgs(args: Record<string, unknown>): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  const rest = Object.fromEntries(
    Object.entries(args).filter(([k]) => k !== "idempotencyKey" && !WAIT_ARGS.has(k)),
  );
  return createHash("sha256").update(JSON.stringify(stable(rest))).digest("hex");
}

/** Bounded, TTL-limited map of idempotency key to result promise. */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly perScope = new Map<string, number>();
  private readonly max: number;
  private readonly maxPerScope: number;
  private readonly ttlMs: number;

  constructor(opts: { max?: number; maxPerScope?: number; ttlMs?: number } = {}) {
    this.max = opts.max ?? IDEMPOTENCY_MAX_ENTRIES;
    this.maxPerScope = opts.maxPerScope ?? IDEMPOTENCY_MAX_PER_CREDENTIAL;
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  /** How many entries one credential (or, without one, one workspace) holds. */
  sizeFor(orgId: string, credentialId?: string): number {
    return this.perScope.get(IdempotencyStore.scope(orgId, credentialId)) ?? 0;
  }

  /** The part of a key that names whose cache it is. */
  static scope(orgId: string, credentialId?: string): string {
    return `${orgId}:${credentialId ?? "-"}`;
  }

  /**
   * Build the cache key for a workspace + credential + tool + caller-supplied key. The credential
   * is optional only for callers that have none to give; every tool passes `whoami().credentialId`.
   */
  static key(orgId: string, tool: string, idempotencyKey: string, credentialId?: string): string {
    return `${IdempotencyStore.scope(orgId, credentialId)}:${tool}:${idempotencyKey}`;
  }

  /** The scope a full key belongs to: everything before the tool name. */
  private static scopeOf(key: string): string {
    const parts = key.split(":");
    return `${parts[0]}:${parts[1] ?? "-"}`;
  }

  private setEntry(key: string, entry: Entry): void {
    if (!this.entries.has(key)) this.perScope.set(entry.scope, (this.perScope.get(entry.scope) ?? 0) + 1);
    this.entries.set(key, entry);
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const n = (this.perScope.get(entry.scope) ?? 1) - 1;
    if (n <= 0) this.perScope.delete(entry.scope);
    else this.perScope.set(entry.scope, n);
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
          //
          // Only the caller still looking at the dead entry may drop it. Everywhere else in here
          // the entry is read and replaced synchronously, which is what makes the in-flight join
          // safe; this branch is the one place we let go of it across two awaits (the promise,
          // then a real HTTP lookup), and a blind delete turned that into the opposite of what
          // the probe is for. Two replays of one key both saw the same dead entry, both came back
          // with `alive === false`, the first re-ran and stored its result, and the second then
          // deleted *that* and re-ran too: one key, two documents, two credit charges, and a
          // second live share link neither caller mentions because each one only sees its own id.
          // A caller that loses the check leaves the winner's entry alone and recurses into it,
          // so it joins the fresh run and gets one document back, marked as the replay it is.
          if (this.entries.get(key) === existing) this.deleteEntry(key);
          return this.run(key, fn, opts);
        }
      }
      return { value: cached, replayed: true };
    }
    if (existing) this.deleteEntry(key);

    const promise = fn();
    const scope = IdempotencyStore.scopeOf(key);
    this.setEntry(key, { promise, expiresAt: now + this.ttlMs, fingerprint: opts.fingerprint, scope });
    this.trim(scope);
    try {
      const value = await promise;
      return { value, replayed: false };
    } catch (err) {
      // A failed write must not be "remembered": the next attempt with the same key runs again.
      if (this.entries.get(key)?.promise === promise) this.deleteEntry(key);
      throw err;
    }
  }

  /** Drop expired entries (called by the session sweeper). */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteEntry(key);
    }
  }

  /**
   * Keep one credential within its cap by dropping its own oldest entries, then keep the whole
   * store within the global ceiling by dropping the oldest of anyone's. Insertion order is age.
   */
  private trim(scope: string): void {
    while ((this.perScope.get(scope) ?? 0) > this.maxPerScope) {
      let oldest: string | undefined;
      for (const [key, entry] of this.entries) {
        if (entry.scope === scope) {
          oldest = key;
          break;
        }
      }
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
  }
}
