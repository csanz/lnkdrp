/**
 * Cron auth (`src/lib/cron/auth.ts`).
 *
 * Two properties matter. A secret in the URL is refused in production, because URLs land in
 * request logs and monitor configs. And the read-only monitor secret opens `/api/monitor/crons`
 * but never a job route, so the uptime monitor vendor cannot run billing or email crons.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { requireCronAuth, requireCronMonitorAuth } from "@/lib/cron/auth";

const CRON = "cron-secret-value";
const MONITOR = "monitor-secret-value";

function bearer(secret: string, path = "/api/cron/doc-metrics"): Request {
  return new Request(`https://lnkdrp.com${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

function query(secret: string, path = "/api/cron/doc-metrics"): Request {
  return new Request(`https://lnkdrp.com${path}?secret=${encodeURIComponent(secret)}`);
}

const status = (res: Response | null) => (res ? res.status : "allowed");

describe("cron/auth", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("LNKDRP_CRON_SECRET", "");
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("CRON_MONITOR_SECRET", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("production", () => {
    beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

    test("accepts the Authorization: Bearer header Vercel Cron sends", () => {
      expect(status(requireCronAuth(bearer(CRON)))).toBe("allowed");
    });

    test("refuses the secret in the query string", () => {
      expect(status(requireCronAuth(query(CRON)))).toBe(401);
      expect(status(requireCronMonitorAuth(query(CRON, "/api/monitor/crons")))).toBe(401);
    });

    test("VERCEL_ENV=production alone also refuses the query string", () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", "production");
      expect(status(requireCronAuth(query(CRON)))).toBe(401);
    });

    test("still fails closed when no secret is configured", () => {
      vi.stubEnv("CRON_SECRET", "");
      expect(status(requireCronAuth(new Request("https://lnkdrp.com/api/cron/doc-metrics")))).toBe(401);
      expect(status(requireCronMonitorAuth(new Request("https://lnkdrp.com/api/monitor/crons")))).toBe(401);
    });
  });

  describe("development", () => {
    beforeEach(() => vi.stubEnv("NODE_ENV", "development"));

    test("keeps the query form for convenience", () => {
      expect(status(requireCronAuth(query(CRON)))).toBe("allowed");
      expect(status(requireCronAuth(query("wrong")))).toBe(401);
    });

    test("is open when no secret is configured", () => {
      vi.stubEnv("CRON_SECRET", "");
      expect(status(requireCronAuth(new Request("http://localhost:3001/api/cron/doc-metrics")))).toBe("allowed");
    });
  });

  describe("monitor secret", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CRON_MONITOR_SECRET", MONITOR);
    });

    test("opens the monitor", () => {
      expect(status(requireCronMonitorAuth(bearer(MONITOR, "/api/monitor/crons")))).toBe("allowed");
    });

    test("never authorizes a job", () => {
      expect(status(requireCronAuth(bearer(MONITOR)))).toBe(401);
    });

    test("the cron secret still opens the monitor, so setting the monitor secret breaks nothing", () => {
      expect(status(requireCronMonitorAuth(bearer(CRON, "/api/monitor/crons")))).toBe("allowed");
    });

    test("falls back to the cron secret when unset", () => {
      vi.stubEnv("CRON_MONITOR_SECRET", "");
      expect(status(requireCronMonitorAuth(bearer(CRON, "/api/monitor/crons")))).toBe("allowed");
      expect(status(requireCronMonitorAuth(bearer(MONITOR, "/api/monitor/crons")))).toBe(401);
    });

    test("a wrong secret is refused", () => {
      expect(status(requireCronMonitorAuth(bearer("nope", "/api/monitor/crons")))).toBe(401);
    });
  });
});
