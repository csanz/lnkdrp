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
