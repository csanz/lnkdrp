/**
 * Local runner: plan-limit grace sweep for Free workspaces.
 *
 * Usage:
 * - Dry run (default):   tsx scripts/plan-limits-grace.ts
 *   (same as `--dry-run`; computes transitions, writes nothing, sends nothing)
 * - Actually run:        tsx scripts/plan-limits-grace.ts --send
 *
 * Optional:
 * - --limit <n>          max workspaces scanned (default 500)
 * - --now <ISO date>     reference time (e.g. to exercise reminder/block transitions locally)
 *
 * Notes:
 * - For safe local testing with `--send` but no real emails, set `EMAIL_TRANSPORT=console`.
 * - Requires Mongo config (`MONGODB_URI`), same as running the app.
 */
import { runPlanLimitsGraceSweep } from "@/lib/billing/planGrace";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return typeof v === "string" ? v : null;
}

async function main() {
  const send = process.argv.includes("--send");
  const dryRun = !send || process.argv.includes("--dry-run");
  const limitRaw = argValue("--limit");
  const limit = limitRaw ? Math.max(1, Math.floor(Number(limitRaw) || 500)) : 500;
  const nowRaw = argValue("--now");
  const nowMs = nowRaw ? Date.parse(nowRaw) : NaN;
  const now = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();

  const res = await runPlanLimitsGraceSweep({ now, dryRun, limit });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
