import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { CRON_JOBS } from "@/lib/cron/jobs";

/**
 * Every cron job must exist in three places that stay in sync by construction:
 *   vercel.json  crons[].path = /api/cron/<job>   (production schedule)
 *   src/app/api/cron/<job>/route.ts               (the job)
 *   scripts/cron/cron.<job>.ts + npm "cron:<job>" (manual / VM runner hitting that route)
 * This test fails when one is added without the others.
 */
const ROOT = join(__dirname, "..", "..");
const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

const scheduled = vercel.crons.map((c) => c.path.replace(/^\/api\/cron\//, ""));
const routes = readdirSync(join(ROOT, "src/app/api/cron"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const scripts = readdirSync(join(ROOT, "scripts/cron")).filter((f) => /^cron\.[a-z0-9-]+\.ts$/.test(f)).map((f) => f.replace(/^cron\./, "").replace(/\.ts$/, ""));
const npmJobs = Object.keys(pkg.scripts).filter((k) => k.startsWith("cron:")).map((k) => k.slice(5));

describe("cron jobs are declared consistently", () => {
  test("every vercel.json cron path has a route", () => {
    for (const job of scheduled) expect(routes, `route for ${job}`).toContain(job);
  });
  test("every cron route is scheduled in vercel.json", () => {
    for (const job of routes) expect(scheduled, `schedule for ${job}`).toContain(job);
  });
  test("every cron job has scripts/cron/cron.<job>.ts", () => {
    for (const job of scheduled) expect(scripts, `script for ${job}`).toContain(job);
    for (const job of scripts) expect(scheduled, `stale script for ${job}`).toContain(job);
  });
  test("every cron job has an npm cron:<job> script pointing at its file", () => {
    for (const job of scheduled) {
      expect(npmJobs, `npm script for ${job}`).toContain(job);
      expect(pkg.scripts[`cron:${job}`]).toContain(`scripts/cron/cron.${job}.ts`);
    }
  });
  test("cron routes are Node functions with an explicit maxDuration", () => {
    for (const job of routes) {
      const src = readFileSync(join(ROOT, "src/app/api/cron", job, "route.ts"), "utf8");
      expect(src, `${job} runtime`).toMatch(/export const runtime = "nodejs"/);
      expect(src, `${job} maxDuration`).toMatch(/export const maxDuration = \d+/);
    }
  });
  test("schedules are valid 5-field cron expressions", () => {
    for (const c of vercel.crons) expect(c.schedule.trim().split(/\s+/), c.path).toHaveLength(5);
  });
  test("the runner library exists", () => {
    expect(existsSync(join(ROOT, "scripts/cron/lib.ts"))).toBe(true);
  });

  // A deployed function cannot read vercel.json, so `src/lib/cron/jobs.ts` repeats the schedules
  // for the monitor to judge lateness against. This is what stops the copy from drifting.
  test("src/lib/cron/jobs.ts lists exactly the scheduled jobs, with the same schedules", () => {
    expect([...CRON_JOBS].map((j) => j.jobKey).sort()).toEqual([...scheduled].sort());
    for (const c of vercel.crons) {
      const job = CRON_JOBS.find((j) => `/api/cron/${j.jobKey}` === c.path);
      expect(job?.schedule, `schedule for ${c.path}`).toBe(c.schedule);
    }
  });
});
