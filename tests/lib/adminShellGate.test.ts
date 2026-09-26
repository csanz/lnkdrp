/**
 * The admin area's pages, not just its data.
 *
 * All 40 endpoints under `/api/admin/*` call `requireAdmin`, so admin data was never reachable
 * without the role. The pages were not gated at all: `src/app/a/layout.tsx` was a client component,
 * and the twenty-two pages under it are client components that fetch those endpoints. A signed-out
 * visitor who typed `/a` got the admin chrome and a sidebar naming every section, with panels that
 * failed to load.
 *
 * Nothing leaked but the shape of the surface, which is still more than a stranger should be handed.
 *
 * What is pinned here: the layout refuses, it refuses with the same answer for every reason, and it
 * decides using the one helper rather than a second opinion about what "admin" means.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const requireAdmin = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
let incoming = new Headers();
let jar: { name: string; value: string }[] = [];

vi.mock("next/headers", () => ({
  headers: async () => incoming,
  cookies: async () => ({ getAll: () => jar }),
}));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/gating/requireAdmin", () => ({
  requireAdmin: (...a: unknown[]) => (requireAdmin as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/components/admin/AdminShell", () => ({
  default: function AdminShell() {
    return null;
  },
}));

const AdminLayout = (await import("@/app/a/layout")).default;

const render = () => AdminLayout({ children: null } as never);

beforeEach(() => {
  vi.clearAllMocks();
  incoming = new Headers({ cookie: "next-auth.session-token=abc", host: "lnkdrp.com" });
  jar = [{ name: "next-auth.session-token", value: "abc" }];
  requireAdmin.mockResolvedValue({ ok: true, userId: "u1", email: "a@b.c" });
});

describe("the layout gate", () => {
  test("an admin gets the shell", async () => {
    const node = await render();

    expect((node as { type?: { name?: string } })?.type?.name).toBe("AdminShell");
    expect(notFound).not.toHaveBeenCalled();
  });

  test("a caller the gate refuses gets a 404, not a redirect", async () => {
    // A redirect would confirm the area exists. The debug routes already answer this way.
    requireAdmin.mockResolvedValue({ ok: false, status: 403, error: "Forbidden" });

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  test("every refusal looks the same, whatever the reason", async () => {
    for (const refusal of [
      { ok: false, status: 401, error: "Not authenticated" },
      { ok: false, status: 403, error: "Forbidden" },
      { ok: false, status: 403, error: "API keys cannot access admin endpoints" },
    ]) {
      requireAdmin.mockResolvedValue(refusal);
      await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(notFound).toHaveBeenCalledTimes(3);
  });
});

describe("how it decides", () => {
  test("it asks the one helper, not a second opinion about what admin means", async () => {
    await render();

    // `requireAdmin` replaced twenty-six hand-rolled copies that had already drifted. A page-side
    // reimplementation would be the twenty-seventh.
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  test("the request it builds carries the caller's own headers", async () => {
    await render();

    const req = requireAdmin.mock.calls[0]?.[0] as Request;
    // The cookie is how the session is read at all...
    expect(req.headers.get("cookie")).toBe("next-auth.session-token=abc");
    // ...and `host` decides the development-only localhost bypass, so dropping it would silently
    // change behaviour on a developer's machine rather than in production.
    expect(req.headers.get("host")).toBe("lnkdrp.com");
  });

  test("the request carries the cookie jar, not just the cookie header", async () => {
    // `getToken` reads the session from `req.cookies` only and never parses the `cookie` header,
    // so a plain `new Request(url, { headers })` reads every admin as signed out in production.
    await render();

    const req = requireAdmin.mock.calls[0]?.[0] as Request & {
      cookies?: { getAll: () => { name: string; value: string }[] };
    };
    expect(req.cookies?.getAll()).toEqual([{ name: "next-auth.session-token", value: "abc" }]);
  });
});
