/**
 * `?dryRun=1` must not touch a job's `CronHealth` row (code review 2026-09-23, M12).
 *
 * Two layers: the helper every route now writes through, and a scan of the five routes the review
 * named to make sure none of them has gone back to writing the model directly.
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  updateOne: vi.fn(async () => ({ acknowledged: true })),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/models/CronHealth", () => ({ CronHealthModel: { updateOne: mocks.updateOne } }));

import { writeCronHealth } from "@/lib/cron/health";

describe("writeCronHealth", () => {
  beforeEach(() => {
    mocks.connectMongo.mockClear();
    mocks.updateOne.mockClear();
  });

  it("writes nothing on a dry run", async () => {
    await writeCronHealth("plan-limits", { status: "running" }, { dryRun: true });
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.connectMongo).not.toHaveBeenCalled();
  });

  it("upserts the job's row on a real run", async () => {
    await writeCronHealth("plan-limits", { status: "ok", lastRunAt: new Date(0) }, { dryRun: false });
    expect(mocks.updateOne).toHaveBeenCalledTimes(1);
    expect((mocks.updateOne.mock.calls as unknown[][])[0]).toEqual([
      { jobKey: "plan-limits" },
      { $set: { status: "ok", lastRunAt: new Date(0) } },
      { upsert: true },
    ]);
  });

  it("lets a database error through, so callers keep their own best-effort handling", async () => {
    mocks.updateOne.mockRejectedValueOnce(new Error("down"));
    await expect(writeCronHealth("x", {}, { dryRun: false })).rejects.toThrow("down");
  });
});

describe("the cron routes with a dry-run mode write health only through the helper", () => {
  const routes = ["notification-emails", "plan-limits", "visit-briefs", "credits-cycle-reconcile", "analytics-reconcile"];
  for (const r of routes) {
    it(r, () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), "src/app/api/cron", r, "route.ts"), "utf8");
      expect(src).not.toMatch(/CronHealthModel\.updateOne/);
      expect(src).toMatch(/writeCronHealth\(/);
      // Every call passes the route's dryRun flag, not a literal.
      const calls = src.match(/writeCronHealth\([\s\S]*?\{ dryRun \},?\s*\)/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  }
});
