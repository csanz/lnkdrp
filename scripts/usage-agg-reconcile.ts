/**
 * Local runner for usage aggregates reconciliation.
 *
 * Usage:
 *   tsx scripts/usage-agg-reconcile.ts --days 45
 *   tsx scripts/usage-agg-reconcile.ts --start 2026-01-01 --end 2026-01-05
 *   tsx scripts/usage-agg-reconcile.ts --workspaceId <ORG_ID> --days 30
 */
import { reconcileUsageAggsFromLedger } from "@/lib/usage/reconcile";

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function parseDay(s: string): Date | null {
  const v = s.trim();
  if (!v) return null;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const daysRaw = arg("--days");
  const startRaw = arg("--start");
  const endRaw = arg("--end");
  const workspaceId = arg("--workspaceId");

  const now = startOfUtcDay(new Date());
  const days = daysRaw ? Math.min(365, Math.max(1, Math.floor(Number(daysRaw) || 45))) : 45;
  const endDay = endRaw ? startOfUtcDay(parseDay(endRaw) ?? now) : now;
  const startDay = startRaw
    ? startOfUtcDay(parseDay(startRaw) ?? endDay)
    : (() => {
        const d = new Date(endDay);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        return d;
      })();
  const endExclusive = (() => {
    const d = new Date(endDay);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  })();

  const res = await reconcileUsageAggsFromLedger({
    startDay,
    endDayExclusive: endExclusive,
    workspaceId: workspaceId ?? null,
  });
  console.log("[usage-agg-reconcile]", res);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


