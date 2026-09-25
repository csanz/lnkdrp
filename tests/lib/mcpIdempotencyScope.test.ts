/**
 * The idempotency cache is scoped per credential and capped per credential (code review
 * 2026-09-23, Low: MCP/AI). Two credentials of one workspace choosing the same key are two
 * callers; one busy credential cannot evict another's replays.
 */
import { describe, expect, it } from "vitest";

import { IdempotencyStore } from "../../mcp/src/idempotency";

describe("IdempotencyStore scope", () => {
  it("keys differ by credential, so one credential never replays another's result", async () => {
    const store = new IdempotencyStore();
    let runs = 0;
    const fn = async () => ({ n: ++runs });
    const a = IdempotencyStore.key("org", "share_pdf", "k1", "cred-a");
    const b = IdempotencyStore.key("org", "share_pdf", "k1", "cred-b");
    expect(a).not.toBe(b);
    const first = await store.run(a, fn);
    const other = await store.run(b, fn);
    const replay = await store.run(a, fn);
    expect(first).toEqual({ value: { n: 1 }, replayed: false });
    expect(other).toEqual({ value: { n: 2 }, replayed: false });
    expect(replay).toEqual({ value: { n: 1 }, replayed: true });
  });

  it("the old three-part key still works for a caller with no credential", async () => {
    const store = new IdempotencyStore();
    const k = IdempotencyStore.key("org", "share_pdf", "k1");
    await store.run(k, async () => 1);
    expect(await store.run(k, async () => 2)).toEqual({ value: 1, replayed: true });
    expect(store.sizeFor("org")).toBe(1);
  });

  it("a credential over its cap loses its own oldest entries, not another credential's", async () => {
    const store = new IdempotencyStore({ maxPerScope: 2, max: 100 });
    const key = (cred: string, k: string) => IdempotencyStore.key("org", "share_pdf", k, cred);
    await store.run(key("busy", "1"), async () => "b1");
    await store.run(key("quiet", "1"), async () => "q1");
    await store.run(key("busy", "2"), async () => "b2");
    await store.run(key("busy", "3"), async () => "b3");

    expect(store.sizeFor("org", "busy")).toBe(2);
    expect(store.sizeFor("org", "quiet")).toBe(1);
    // busy/1 was evicted: a replay of it runs again.
    expect(await store.run(key("busy", "1"), async () => "b1-again")).toEqual({ value: "b1-again", replayed: false });
    // quiet/1 is untouched.
    expect(await store.run(key("quiet", "1"), async () => "never")).toEqual({ value: "q1", replayed: true });
  });

  it("the global ceiling still holds across credentials", async () => {
    const store = new IdempotencyStore({ maxPerScope: 10, max: 3 });
    for (let i = 0; i < 5; i++) {
      await store.run(IdempotencyStore.key("org", "t", String(i), `c${i}`), async () => i);
    }
    expect(store.size).toBe(3);
  });

  it("sweep and failure eviction keep the per-credential counts right", async () => {
    const store = new IdempotencyStore({ ttlMs: -1 });
    const k = IdempotencyStore.key("org", "t", "x", "c");
    await store.run(k, async () => 1);
    store.sweep();
    expect(store.sizeFor("org", "c")).toBe(0);
    await store
      .run(k, async () => {
        throw new Error("boom");
      })
      .catch(() => undefined);
    expect(store.sizeFor("org", "c")).toBe(0);
  });
});
