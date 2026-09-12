/**
 * Cron overlap lease.
 *
 * Prevents two invocations of the same job from running concurrently (e.g. a slow
 * run overlapping the next scheduled tick). Backed by `CronHealth.leaseUntil` and an
 * atomic `findOneAndUpdate` that only succeeds when the lease is absent or expired.
 */
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { debugLog, debugError } from "@/lib/debug";

export type AcquireCronLeaseParams = {
  /** Stable job identifier (matches `CronHealth.jobKey`). */
  jobKey: string;
  /** How long the lease is held before it auto-expires (guards against crashed runs). */
  ttlMs: number;
};

export type CronLease = {
  jobKey: string;
  /** Unique token for this holder; release only succeeds for the matching token. */
  token: string;
  leaseUntil: Date;
};

/**
 * Try to acquire the lease for `jobKey`.
 *
 * Returns a lease handle when acquired, or `null` when another run currently holds it.
 * Throws only on unexpected DB errors.
 */
export async function acquireCronLease(params: AcquireCronLeaseParams): Promise<CronLease | null> {
  const jobKey = params.jobKey.trim();
  if (!jobKey) throw new Error("acquireCronLease: jobKey is required");
  const ttlMs = Number.isFinite(params.ttlMs) && params.ttlMs > 0 ? Math.floor(params.ttlMs) : 60_000;

  await connectMongo();

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + ttlMs);
  const token = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // Ensure the heartbeat row exists so the conditional update below can match it.
  // `$setOnInsert` only fires on insert, so an existing row is left untouched.
  await CronHealthModel.updateOne(
    { jobKey },
    { $setOnInsert: { jobKey, leaseUntil: null, leaseToken: null } },
    { upsert: true },
  );

  const acquired = await CronHealthModel.findOneAndUpdate(
    {
      jobKey,
      $or: [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseUntil, leaseToken: token } },
    { new: true },
  )
    .select({ _id: 1, leaseUntil: 1 })
    .lean();

  if (!acquired) {
    debugLog(1, "[cron-lease] locked", { jobKey });
    return null;
  }

  debugLog(2, "[cron-lease] acquired", { jobKey, leaseUntil: leaseUntil.toISOString() });
  return { jobKey, token, leaseUntil };
}

/**
 * Release a previously acquired lease.
 *
 * Best-effort: only clears the lease if this holder's token still matches (so a
 * later holder that took over after expiry is not clobbered). Never throws.
 */
export async function releaseCronLease(lease: CronLease | null | undefined): Promise<void> {
  if (!lease) return;
  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey: lease.jobKey, leaseToken: lease.token },
      { $set: { leaseUntil: null, leaseToken: null } },
    );
    debugLog(2, "[cron-lease] released", { jobKey: lease.jobKey });
  } catch (err) {
    debugError(1, "[cron-lease] release failed", {
      jobKey: lease.jobKey,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
