/**
 * Optimistic star and reorder writes roll back when the server refuses them (code review
 * 2026-09-23, Low), and never undo a newer click that landed in the meantime.
 *
 * `src/lib/starredDocs.ts` talks to `window.localStorage` and `window.dispatchEvent`; both are
 * stubbed here, and the module is imported after the stub so its `typeof window` checks pass.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ORG_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const store = new Map<string, string>();
const fetchMock = vi.fn();

function key(): string {
  return `lnkdrp-starred-docs-v2:${ORG_ID}`;
}
function stored(): Array<{ id: string }> {
  return JSON.parse(store.get(key()) ?? "[]") as Array<{ id: string }>;
}
/** Let the fire-and-forget server sync settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let mod: typeof import("@/lib/starredDocs");

beforeAll(async () => {
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  Object.assign(globalThis, {
    window: { localStorage, dispatchEvent: () => true, addEventListener: () => undefined },
    fetch: fetchMock,
  });
  store.set("lnkdrp-active-org-id", ORG_ID);
  mod = await import("@/lib/starredDocs");
});

afterEach(() => {
  fetchMock.mockReset();
  store.delete(key());
});

describe("starred docs optimistic rollback", () => {
  it("a refused star is unlit again", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 402, json: async () => ({}) });
    const out = mod.toggleStarredDoc({ id: "d1", title: "Deck" });
    expect(out.starred).toBe(true);
    expect(stored().map((d) => d.id)).toEqual(["d1"]);
    await settle();
    expect(stored()).toEqual([]);
  });

  it("a network failure rolls the star back too", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    mod.toggleStarredDoc({ id: "d1", title: "Deck" });
    await settle();
    expect(stored()).toEqual([]);
  });

  it("a newer click is not undone by an older failure", async () => {
    let refuse: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (refuse = r)));
    mod.toggleStarredDoc({ id: "d1", title: "Deck" });
    // Second click lands while the first request is still open, and its request succeeds.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ docs: [] }) });
    mod.toggleStarredDoc({ id: "d1", title: "Deck" });
    expect(stored()).toEqual([]);
    refuse({ ok: false, status: 500, json: async () => ({}) });
    await settle();
    // The first failure finds a cache that is no longer its own write and leaves it alone.
    expect(stored()).toEqual([]);
  });

  it("a refused reorder restores the previous order", async () => {
    store.set(
      key(),
      JSON.stringify([
        { id: "a", title: "A", starredAt: 1, sortKey: 0 },
        { id: "b", title: "B", starredAt: 1, sortKey: 1 },
      ]),
    );
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const out = mod.moveStarredDoc("b", "up");
    expect(out.moved).toBe(true);
    expect(stored().map((d) => d.id)).toEqual(["b", "a"]);
    await settle();
    expect(stored().map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("revertStarredOptimistic writes only while the cache still holds the expected state", () => {
    store.set(key(), JSON.stringify([{ id: "x", title: "X", starredAt: 1 }]));
    const expected = [{ id: "x", title: "X", starredAt: 1 }];
    const previous: typeof expected = [];
    expect(mod.revertStarredOptimistic([{ id: "y", title: "Y", starredAt: 1 }], previous)).toBe(false);
    expect(stored().map((d) => d.id)).toEqual(["x"]);
    expect(mod.revertStarredOptimistic(expected, previous)).toBe(true);
    expect(stored()).toEqual([]);
  });
});
