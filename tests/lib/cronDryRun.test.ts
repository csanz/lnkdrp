/**
 * `--dry-run` must never be the thing that makes a job do its work for real.
 *
 * `scripts/cron/lib.ts` appends `dryRun=1` to whichever job is named — the flag belongs to the
 * CLI, not to the route — so every route is handed it whether or not it implements one. Five did
 * not, and ignored it in silence. `npm run cron:stripe-credits-report -- --dry-run` reported meter
 * events to Stripe and billed for them; `stripe-credits-reconcile` wrote subscription rows and
 * granted credits.
 *
 * So the rule is: a route either honours the flag or refuses it. What must not exist is a third
 * state where the flag is accepted and ignored.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const CRON_DIR = path.join(ROOT, "src/app/api/cron");

function routeFiles(): Array<{ job: string; src: string }> {
  return fs
    .readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ job: e.name, file: path.join(CRON_DIR, e.name, "route.ts") }))
    .filter((r) => fs.existsSync(r.file))
    .map((r) => ({ job: r.job, src: fs.readFileSync(r.file, "utf8") }));
}

describe("every cron route answers for --dry-run", () => {
  test("a route either implements dryRun or refuses it", () => {
    const silent = routeFiles()
      .filter(({ src }) => !src.includes("refuseUnsupportedDryRun") && !/\bdryRun\b/.test(src))
      .map(({ job }) => job);
    expect(
      silent,
      "these accept --dry-run and ignore it; implement it or call refuseUnsupportedDryRun",
    ).toEqual([]);
  });

  test("a route that refuses does not also claim to support it", () => {
    // Both together is the ambiguous state the guard exists to prevent.
    const both = routeFiles()
      .filter(({ src }) => src.includes("refuseUnsupportedDryRun") && /const dryRun\s*=/.test(src))
      .map(({ job }) => job);
    expect(both, "these both refuse and implement dryRun — pick one").toEqual([]);
  });

  test("the CLI still sends the flag, which is why routes must answer for it", () => {
    const cli = fs.readFileSync(path.join(ROOT, "scripts/cron/lib.ts"), "utf8");
    expect(cli).toContain('url.searchParams.set("dryRun", "1")');
  });
});
