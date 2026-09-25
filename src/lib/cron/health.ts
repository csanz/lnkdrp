/**
 * The one way a cron route writes its `CronHealth` row.
 *
 * A dry run is a report, not a run. Five routes (`notification-emails`, `plan-limits`,
 * `visit-briefs`, `credits-cycle-reconcile`, `analytics-reconcile`) wrote `status: "running"` and
 * then `ok`/`error` on `?dryRun=1` exactly as on a real run, so a person checking what a job would
 * do overwrote the record of when it last really did it: `lastRunAt`, `lastResult` and
 * `lastParams` all said "just now, and it did nothing", and `/api/monitor/crons` reported a job
 * healthy that had not actually run in days. `account-purge` already skipped the writes on a dry
 * run; this puts that rule in one place so a route cannot forget it.
 */
import { CronHealthModel } from "@/lib/models/CronHealth";
import { connectMongo } from "@/lib/mongodb";

/**
 * Upsert `$set` onto the job's health row, unless `dryRun`, in which case nothing is written and
 * the promise resolves at once. Throws what the database throws; callers that treat health as
 * best-effort wrap it in their own try/catch, as they did the raw `updateOne`.
 */
export async function writeCronHealth(
  jobKey: string,
  set: Record<string, unknown>,
  opts: { dryRun: boolean },
): Promise<void> {
  if (opts.dryRun) return;
  await connectMongo();
  await CronHealthModel.updateOne({ jobKey }, { $set: set }, { upsert: true });
}
