import { afterEach, describe, expect, it, vi } from "vitest";

import { __getLastMongoRequestLog } from "@/lib/db/mongoRequestLogger";

function canRun() {
  return Boolean(process.env.MONGODB_URI) && Boolean(process.env.API_TEST_USER_ID);
}

describe("stats endpoints mongo op guardrails (dev-only)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.skipIf(!canRun())("dashboard stats stays under a mongo command budget", async () => {
    vi.stubEnv("DEBUG_LEVEL", "2");
    // NODE_ENV is typed read-only in @types/node; stubEnv is the supported way to set it in tests.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("API_TEST_BYPASS_AUTH", "1");

    const { GET } = await import("@/app/api/dashboard/stats/route");
    const req = new Request("http://localhost:3001/api/dashboard/stats");
    await GET(req);

    const last = __getLastMongoRequestLog();
    expect(last?.path).toBe("/api/dashboard/stats");
    expect(typeof last?.ops).toBe("number");
    // Driver commands can exceed Mongoose calls; keep headroom but ensure boundedness.
    expect((last?.ops ?? 9999)).toBeLessThanOrEqual(80);
  });

  it.skipIf(!canRun())("credits snapshot stays under a mongo command budget", async () => {
    vi.stubEnv("DEBUG_LEVEL", "2");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("API_TEST_BYPASS_AUTH", "1");

    const { GET } = await import("@/app/api/credits/snapshot/route");
    const req = new Request("http://localhost:3001/api/credits/snapshot");
    await GET(req);

    const last = __getLastMongoRequestLog();
    expect(last?.path).toBe("/api/credits/snapshot");
    expect(typeof last?.ops).toBe("number");
    expect((last?.ops ?? 9999)).toBeLessThanOrEqual(30);
  });
});


