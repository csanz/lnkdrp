/**
 * A forced sidebar refresh during an in-flight request runs a second fetch afterwards instead of
 * riding the stale one (code review 2026-09-23, M34). The failure this guards: delete a document,
 * the delete's forced refresh coalesces onto a sidebar request that started before the delete, the
 * pre-delete list arrives last and is stored, and the deleted document is back in the sidebar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTempUser: vi.fn(),
}));
vi.mock("@/lib/gating/tempUserClient", () => ({ fetchWithTempUser: mocks.fetchWithTempUser }));

const ORG_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

/** The browser surface the module reads: localStorage for the active org, window events, document. */
function installBrowser(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    localStorage,
    addEventListener: (t: string, fn: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = {};
  (globalThis as { localStorage?: unknown }).localStorage = localStorage;
  (globalThis as { Event?: unknown }).Event = class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  store.set("lnkdrp-active-org-id", ORG_ID);
}

type Deferred = { resolve: (r: Response) => void; promise: Promise<Response> };
function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { resolve, promise };
}

function sidebarResponse(docIds: string[]): Response {
  return new Response(
    JSON.stringify({
      docs: { items: docIds.map((id) => ({ id, title: id })), total: docIds.length, page: 1, limit: 20 },
      projects: { items: [], total: 0, page: 1, limit: 10 },
      requests: { items: [], total: 0, page: 1, limit: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("refreshSidebarCache with force during an in-flight request", () => {
  beforeEach(() => {
    installBrowser();
    mocks.fetchWithTempUser.mockReset();
    vi.resetModules();
  });

  it("queues one follow-up fetch after the in-flight one, and stores its result last", async () => {
    const first = deferred();
    const second = deferred();
    mocks.fetchWithTempUser.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const mod = await import("@/lib/sidebarCache");
    const p1 = mod.refreshSidebarCache({ force: true, reason: "boot" });
    // Two forced calls while the first request is still running share one follow-up: two fetches
    // in total, never three.
    const p2 = mod.refreshSidebarCache({ force: true, reason: "doc-deleted" });
    const p3 = mod.refreshSidebarCache({ force: true, reason: "doc-deleted-again" });
    expect(mocks.fetchWithTempUser).toHaveBeenCalledTimes(1);

    // The pre-delete list arrives.
    first.resolve(sidebarResponse(["doc-a", "doc-b"]));
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.fetchWithTempUser).toHaveBeenCalledTimes(2);
    expect(mod.getSidebarCacheSnapshot({ orgId: ORG_ID })?.docs.items.map((d) => d.id)).toEqual(["doc-a", "doc-b"]);

    // The follow-up brings the post-delete list, which wins.
    second.resolve(sidebarResponse(["doc-a"]));
    await Promise.all([p2, p3]);
    expect(mocks.fetchWithTempUser).toHaveBeenCalledTimes(2);
    expect(mod.getSidebarCacheSnapshot({ orgId: ORG_ID })?.docs.items.map((d) => d.id)).toEqual(["doc-a"]);
  });

  it("an unforced call during an in-flight request still coalesces onto it", async () => {
    const first = deferred();
    mocks.fetchWithTempUser.mockImplementationOnce(() => first.promise);
    const mod = await import("@/lib/sidebarCache");
    const p1 = mod.refreshSidebarCache({ force: true });
    const p2 = mod.refreshSidebarCache({});
    first.resolve(sidebarResponse([]));
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.fetchWithTempUser).toHaveBeenCalledTimes(1);
  });
});
