/**
 * The Vercel read-only client, and the admin route on top of it.
 *
 * This is optional insight bolted onto a product that must not care whether it exists. Everything
 * pinned here is about that: the four ways this integration could stop being optional, and the one
 * way it could leak.
 *
 * - **Unconfigured must degrade, not throw.** Most deployments (and every developer machine) have
 *   no Vercel token. If an absent token raised, a page nobody asked for would take the admin area
 *   down on exactly the machines least able to notice.
 * - **The token must never come back out.** It is a read-only credential to the whole project, it
 *   travels in a header so it cannot land in a URL log, and any string bound for an admin screen is
 *   scrubbed of it. That includes a network error message, which on Node can quote the request.
 * - **Someone else's non-200 is not our 500.** Vercel answering 403 is information for the page,
 *   not a failure of our route.
 * - **Every call is bounded.** A hung upstream read must end by itself. The timeout test lets the
 *   mocked fetch honour the abort signal, so what is proven is that a real signal with a real
 *   deadline reaches the call, not that the code merely mentions one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/gating/requireAdmin", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, userId: "staff", email: "staff@lnkdrp.test" })),
}));

const { listDeployments, getProject, vercelConfig, isVercelConfigured } = await import("@/lib/vercel/client");
const { GET } = await import("@/app/api/admin/deployments/route");

/** The string that must never appear in anything this module hands back. */
const TOKEN = "vc-token-that-must-never-be-returned-to-a-browser";
const PROJECT = "prj_lnkdrp_test";

const realFetch = globalThis.fetch;

/** A deployment with credentials set. */
function configure(): void {
  vi.stubEnv("VERCEL_API_TOKEN", TOKEN);
  vi.stubEnv("VERCEL_PROJECT_ID", PROJECT);
}

/** A deployment with none, which is the normal case everywhere but production. */
function unconfigure(): void {
  vi.stubEnv("VERCEL_API_TOKEN", "");
  vi.stubEnv("VERCEL_PROJECT_ID", "");
  vi.stubEnv("VERCEL_TEAM_ID", "");
}

/** A `fetch` that answers every call with this JSON and this status, and records what it was asked. */
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/** One deployment as the v6 list endpoint shapes it. */
function rawDeployment(extra: Record<string, unknown> = {}) {
  return {
    uid: "dpl_abc123",
    name: "www-lnkdrp",
    url: "www-lnkdrp-abc123.vercel.app",
    created: 1_726_000_000_000,
    buildingAt: 1_726_000_010_000,
    ready: 1_726_000_070_000,
    state: "READY",
    target: "production",
    inspectorUrl: "https://vercel.com/acme/www-lnkdrp/abc123",
    creator: { uid: "u1", username: "csanz", email: "someone@example.test" },
    meta: {
      githubCommitSha: "0123456789abcdef0123456789abcdef01234567",
      githubCommitMessage: "fix(admin): the deploy board\n\nbody that must not reach the cell",
      githubCommitRef: "main",
    },
    ...extra,
  };
}

/** A request the admin gate would see from the real host, not from localhost. */
function req(url: string): Request {
  return new Request(url, { headers: { host: "lnkdrp.com" } });
}

describe("lib/vercel/client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("VERCEL_TEAM_ID", "");
    vi.stubEnv("VERCEL_API_TIMEOUT_MS", "");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  describe("unconfigured", () => {
    test("reports itself instead of throwing, and never calls out", async () => {
      unconfigure();
      const spy = vi.fn();
      globalThis.fetch = spy as unknown as typeof fetch;

      const res = await listDeployments(10);

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.reason).toBe("not_configured");
      // The page has to be able to say what to set, so the names are in the message.
      expect(res.message).toContain("VERCEL_API_TOKEN");
      expect(res.message).toContain("VERCEL_PROJECT_ID");
      expect(spy).not.toHaveBeenCalled();
    });

    test("every read degrades the same way", async () => {
      unconfigure();
      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      await expect(getProject()).resolves.toMatchObject({ ok: false, reason: "not_configured" });
      expect(isVercelConfigured()).toBe(false);
      expect(vercelConfig()).toMatchObject({ configured: false, missing: ["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID"] });
    });

    test("half-configured is unconfigured, and says which half", () => {
      vi.stubEnv("VERCEL_API_TOKEN", TOKEN);
      vi.stubEnv("VERCEL_PROJECT_ID", "");

      expect(vercelConfig()).toMatchObject({ configured: false, missing: ["VERCEL_PROJECT_ID"] });
    });
  });

  describe("the token never comes back out", () => {
    test("not from the config summary", () => {
      configure();
      expect(JSON.stringify(vercelConfig())).not.toContain(TOKEN);
    });

    test("not from a successful read, even when the upstream body echoes it", async () => {
      configure();
      // A hostile (or just careless) upstream body carrying the token in several places.
      stubFetch(200, {
        deployments: [rawDeployment({ meta: { githubCommitMessage: `leak ${TOKEN}`, githubCommitSha: TOKEN } })],
        token: TOKEN,
      });

      const res = await listDeployments(5);

      expect(res.ok).toBe(true);
      // Two defences, and this asserts the second. Fields are picked by hand, so the stray
      // top-level `token` is never forwarded at all; and every string taken out of an upstream body
      // is scrubbed, so a token pasted into a commit message comes back redacted rather than read.
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    });

    test("not from a non-200", async () => {
      configure();
      stubFetch(403, { error: { message: `bad token ${TOKEN}` } });

      const res = await listDeployments(5);

      expect(res).toMatchObject({ ok: false, reason: "http", status: 403 });
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    });

    test("not from a network error that quotes the request", async () => {
      configure();
      globalThis.fetch = vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED (Authorization: Bearer ${TOKEN})`);
      }) as unknown as typeof fetch;

      const res = await listDeployments(5);

      expect(res).toMatchObject({ ok: false, reason: "network" });
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      if (res.ok) throw new Error("unreachable");
      expect(res.message).toContain("[redacted]");
    });

    test("it travels in a header, never in the URL", async () => {
      configure();
      vi.stubEnv("VERCEL_TEAM_ID", "team_lnkdrp");
      const spy = stubFetch(200, { deployments: [] });

      await listDeployments(5);

      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).not.toContain(TOKEN);
      expect(url).toContain(`projectId=${PROJECT}`);
      // Team-scoped projects need this, and leaving it off is the usual cause of a 403.
      expect(url).toContain("teamId=team_lnkdrp");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.method).toBe("GET");
    });
  });

  describe("parsing", () => {
    test("reduces one v6 deployment to the fields the board shows", async () => {
      configure();
      stubFetch(200, { deployments: [rawDeployment()] });

      const res = await listDeployments(5);

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: "dpl_abc123",
        state: "READY",
        target: "production",
        commitSha: "0123456",
        commitMessage: "fix(admin): the deploy board",
        commitRef: "main",
        creator: "csanz",
        // ready (…070_000) minus buildingAt (…010_000), not minus created.
        durationMs: 60_000,
      });
      // The creator's email address is in the upstream body and has no business on this board.
      expect(JSON.stringify(res.data)).not.toContain("someone@example.test");
    });

    test("a deployment still building has no duration rather than a wrong one", async () => {
      configure();
      stubFetch(200, { deployments: [rawDeployment({ ready: undefined, state: "BUILDING" })] });

      const res = await listDeployments(5);

      if (!res.ok) throw new Error("unreachable");
      expect(res.data[0]).toMatchObject({ state: "BUILDING", readyAt: null, durationMs: null });
    });

    test("the older `readyState` spelling is read when `state` is absent", async () => {
      configure();
      stubFetch(200, { deployments: [rawDeployment({ state: undefined, readyState: "ERROR" })] });

      const res = await listDeployments(5);

      if (!res.ok) throw new Error("unreachable");
      expect(res.data[0].state).toBe("ERROR");
    });

    test("a 2xx with no deployments array is a bad response, not a crash", async () => {
      configure();
      stubFetch(200, { unexpected: true });

      await expect(listDeployments(5)).resolves.toMatchObject({ ok: false, reason: "bad_response" });
    });
  });

  describe("every call is bounded", () => {
    test("a hung upstream read ends by itself", async () => {
      configure();
      vi.stubEnv("VERCEL_API_TIMEOUT_MS", "25");

      let seen: AbortSignal | null = null;
      globalThis.fetch = vi.fn((_url: unknown, init: RequestInit) => {
        // A real fetch aborts on this signal. Honouring it here is what makes the assertion mean
        // "a live deadline reached the call" rather than "the source mentions a timeout".
        seen = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          seen?.addEventListener("abort", () => reject(seen?.reason));
        });
      }) as unknown as typeof fetch;

      const res = await listDeployments(5);

      expect(seen).toBeInstanceOf(AbortSignal);
      expect(res).toMatchObject({ ok: false, reason: "timeout" });
      if (res.ok) throw new Error("unreachable");
      expect(res.message).toContain("25ms");
    });
  });
});

describe("GET /api/admin/deployments", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("VERCEL_TEAM_ID", "");
    vi.stubEnv("VERCEL_API_TIMEOUT_MS", "");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  // Each case uses its own `limit` on purpose: the route memoises per limit for a minute, and a
  // shared limit would serve the previous case's answer.
  test("a non-200 from Vercel does not become a 500 here", async () => {
    configure();
    stubFetch(403, { error: { message: `forbidden ${TOKEN}` } });

    const res = await GET(req("https://lnkdrp.com/api/admin/deployments?limit=7"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deployments).toEqual([]);
    expect(body.upstream).toMatchObject({ reason: "http", status: 403 });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("a 500 from Vercel is reported, not mirrored", async () => {
    configure();
    stubFetch(500, { error: "upstream exploded" });

    const res = await GET(req("https://lnkdrp.com/api/admin/deployments?limit=8"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.upstream).toMatchObject({ reason: "http", status: 500 });
  });

  test("unconfigured answers 200 and names what to set", async () => {
    unconfigure();
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await GET(req("https://lnkdrp.com/api/admin/deployments?limit=9"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.missing).toEqual(["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID"]);
    expect(body.deployments).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a healthy read is served, and the token is not in the payload", async () => {
    configure();
    stubFetch(200, { deployments: [rawDeployment()] });

    const res = await GET(req("https://lnkdrp.com/api/admin/deployments?limit=11"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.upstream).toBeNull();
    expect(Array.isArray(body.deployments) && body.deployments.length).toBe(1);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    // The board must not be cached by a shared cache anywhere between here and the browser.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("the second read inside the window is served from memory", async () => {
    configure();
    const spy = stubFetch(200, { deployments: [rawDeployment()] });

    const first = (await (await GET(req("https://lnkdrp.com/api/admin/deployments?limit=12"))).json()) as Record<string, unknown>;
    const second = (await (await GET(req("https://lnkdrp.com/api/admin/deployments?limit=12"))).json()) as Record<string, unknown>;

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("an unauthorised caller gets the gate's own status, not a board", async () => {
    const { requireAdmin } = await import("@/lib/gating/requireAdmin");
    vi.mocked(requireAdmin).mockResolvedValueOnce({ ok: false, status: 403, error: "Forbidden" });

    const res = await GET(req("https://lnkdrp.com/api/admin/deployments?limit=13"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});
