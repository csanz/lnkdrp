import { describe, expect, it } from "vitest";

import { fingerprintArgs, IdempotencyStore } from "../../mcp/src/idempotency";
import { ToolError } from "../../mcp/src/errors";

/** A reused idempotencyKey must not silently return a result for different arguments (mt_PJp1Ji4_hS). */
describe("IdempotencyStore fingerprints", () => {
  it("replays the stored result for the same arguments", async () => {
    const store = new IdempotencyStore();
    let runs = 0;
    const fn = async () => ({ n: ++runs });
    const fp = fingerprintArgs({ idempotencyKey: "k", title: "A" });
    await store.run("k", fn, { fingerprint: fp });
    const again = await store.run("k", fn, { fingerprint: fingerprintArgs({ title: "A", idempotencyKey: "k" }) });
    expect(again).toEqual({ value: { n: 1 }, replayed: true });
  });

  it("refuses the same key with different arguments", async () => {
    const store = new IdempotencyStore();
    await store.run("k", async () => 1, { fingerprint: fingerprintArgs({ idempotencyKey: "k", title: "A" }) });
    const err = await store.run("k", async () => 2, { fingerprint: fingerprintArgs({ idempotencyKey: "k", title: "B" }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).details).toEqual({ code: "idempotency_key_reused" });
  });

  it("ignores key order and the key itself", () => {
    expect(fingerprintArgs({ a: 1, b: { c: 2, d: 3 }, idempotencyKey: "x" })).toBe(fingerprintArgs({ b: { d: 3, c: 2 }, a: 1, idempotencyKey: "y" }));
  });
});

/**
 * A replay must not outlive the thing it describes.
 *
 * Create a document with a key, delete it, retry the key: the tool used to answer with the original
 * success — same docId, status "ready", no warning — describing something that no longer exists, and
 * the agent handed a dead share link to a human. The cache cannot detect that alone, because only
 * the caller knows what the stored value points at, so the caller supplies `stillExists`.
 */
describe("idempotency: replays of deleted objects", () => {
  it("a replay whose object is gone runs again instead of returning the corpse", async () => {
    const store = new IdempotencyStore();
    let created = 0;
    const alive = new Set<string>();
    const run = async () => {
      created += 1;
      const id = `doc-${created}`;
      alive.add(id);
      return { docId: id };
    };
    const stillExists = async (v: { docId: string }) => alive.has(v.docId);

    const first = await store.run("k", run, { stillExists });
    expect(first).toEqual({ value: { docId: "doc-1" }, replayed: false });

    // Still there: the same document comes back, marked as a replay, with no second create.
    const replay = await store.run("k", run, { stillExists });
    expect(replay).toEqual({ value: { docId: "doc-1" }, replayed: true });
    expect(created).toBe(1);

    // Deleted between calls: the key is forgotten and the retry does the real work.
    alive.delete("doc-1");
    const afterDelete = await store.run("k", run, { stillExists });
    expect(afterDelete).toEqual({ value: { docId: "doc-2" }, replayed: false });
    expect(created).toBe(2);
  });

  /**
   * Two retries of one key, arriving together, must still create one thing.
   *
   * The probe reads the entry, then awaits it, then awaits a real lookup, so two callers on the
   * same key both saw the same dead entry and both concluded "gone". The first re-ran and stored
   * its result; the second deleted that and re-ran as well. One key, two documents, two credit
   * charges, and a second share link neither caller reports because each only sees its own id.
   * Exactly the retry the store exists for: the first call timed out at the transport, a human
   * deleted the document, and the client asked twice.
   */
  it("two concurrent replays of a deleted object run the write once between them", async () => {
    const store = new IdempotencyStore();
    let created = 0;
    const alive = new Set<string>();
    const run = async () => {
      created += 1;
      const id = `doc-${created}`;
      alive.add(id);
      return { docId: id };
    };
    // Awaits before answering, like the getDoc this stands in for: the window is real, not a tick.
    const stillExists = async (v: { docId: string }) => {
      await Promise.resolve();
      return alive.has(v.docId);
    };

    const first = await store.run("k", run, { stillExists });
    expect(first.value).toEqual({ docId: "doc-1" });
    alive.delete("doc-1");

    const [a, b] = await Promise.all([
      store.run("k", run, { stillExists }),
      store.run("k", run, { stillExists }),
    ]);

    expect(created).toBe(2);
    expect(a.value).toEqual({ docId: "doc-2" });
    expect(b.value).toEqual({ docId: "doc-2" });
    // The loser joined the winner's run rather than starting its own, so it is a replay.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it("a failed existence check is treated as still there, not as a deletion", async () => {
    const store = new IdempotencyStore();
    let created = 0;
    const run = async () => {
      created += 1;
      return { docId: `doc-${created}` };
    };
    // A lookup that throws is a bad minute on the network, not evidence the document is gone;
    // re-creating on it would be worse than a stale replay.
    const stillExists = async () => {
      throw new Error("upstream unavailable");
    };

    await store.run("k", run, { stillExists });
    const replay = await store.run("k", run, { stillExists });
    expect(replay.replayed).toBe(true);
    expect(created).toBe(1);
  });

  it("without a checker the cache behaves exactly as it did", async () => {
    const store = new IdempotencyStore();
    let created = 0;
    const run = async () => ({ n: (created += 1) });
    await store.run("k", run);
    const replay = await store.run("k", run);
    expect(replay).toEqual({ value: { n: 1 }, replayed: true });
    expect(created).toBe(1);
  });
});


describe("fingerprintArgs and the wait options", () => {
  it("treats a retry that stops waiting as the same request", () => {
    // The retry the store exists for: the first call blocked and timed out, so the second asks
    // again without waiting. Hashing waitForReady/timeoutSeconds made that the one retry it
    // refused - same key, same document, same file, idempotency_key_reused.
    const first = { idempotencyKey: "k", title: "Deck", sourceUrl: "https://x/a.pdf", waitForReady: true, timeoutSeconds: 60 };
    const retry = { idempotencyKey: "k", title: "Deck", sourceUrl: "https://x/a.pdf", waitForReady: false };
    expect(fingerprintArgs(retry)).toBe(fingerprintArgs(first));
  });

  it("still refuses a key reused for a genuinely different request", () => {
    const a = { idempotencyKey: "k", title: "Deck", sourceUrl: "https://x/a.pdf" };
    const b = { idempotencyKey: "k", title: "Deck", sourceUrl: "https://x/b.pdf" };
    expect(fingerprintArgs(b)).not.toBe(fingerprintArgs(a));
  });

  it("keeps optimize inside the fingerprint, because it changes the bytes uploaded", () => {
    const on = { idempotencyKey: "k", filePath: "/tmp/a.pdf", optimize: true };
    const off = { idempotencyKey: "k", filePath: "/tmp/a.pdf", optimize: false };
    expect(fingerprintArgs(off)).not.toBe(fingerprintArgs(on));
  });

  it("ignores the key itself, so two keys on the same request agree", () => {
    expect(fingerprintArgs({ idempotencyKey: "one", docId: "d" })).toBe(fingerprintArgs({ idempotencyKey: "two", docId: "d" }));
  });
});
