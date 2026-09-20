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
