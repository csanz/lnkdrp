/**
 * Credits reserved for a run that died, given back.
 *
 * `reserveCreditsOrThrow` decrements the balance and writes a `pending` ledger row; the settle step
 * flips that row to `charged`, `refunded` or `failed` within the same run. If the process dies in
 * between — a function killed at `maxDuration`, a deploy mid-run, an OOM — the row stays `pending`
 * forever and the credits stay deducted from a workspace that can never spend them. Nothing swept
 * them up: the admin anomaly page has reported them as `stale_pending` for a while, but reporting a
 * loss is not recovering it, and the only lever an operator had was granting credits back by hand,
 * which leaves the row pending, keeps the anomaly firing and leaves `usedThisCycle` overstated.
 *
 * The biggest single cause is closed (the automatic compare now carries a 90s abort, so it can no
 * longer hang inside `after()` until the whole function is killed). This is for everything else,
 * because "the process died between two writes" is not a bug you finish fixing.
 *
 * **Why an hour is safe.** A reservation is settled within one AI run, and the longest run the
 * product can start is bounded well under two minutes. An hour is the threshold the anomaly sweep
 * already uses and already justifies in writing, so this releases exactly what that page has been
 * calling lost — no new policy, just the missing second half.
 *
 * **Why `ai_run` only.** The ledger also carries grant rows (`cycle_grant_included`,
 * `free_floor_grant`). Those are written `charged` and so are never pending, but a sweeper that
 * refunds by status alone is one schema change away from handing a workspace credits it was never
 * charged for — printing money rather than returning it. Scoping to the event type that actually
 * reserves makes that impossible rather than merely unlikely.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { failAndRefundLedger } from "@/lib/credits/creditService";
import { STALE_PENDING_MS } from "@/lib/admin/creditsAdmin";

/** The most rows one run will touch, so a backlog drains over several runs instead of timing out. */
const DEFAULT_LIMIT = 500;

export type StaleReservationRow = {
  ledgerId: string;
  workspaceId: string;
  actionType: string;
  creditsReserved: number;
  ageMs: number;
};

export type ReleaseStaleReservationsResult = {
  /** Rows matching the cutoff that this run looked at. */
  scanned: number;
  /** Rows this run actually put back. */
  released: number;
  /** Credits returned to workspaces, summed. */
  creditsReturned: number;
  /**
   * Rows that settled between the scan and the release — a run that finished late, which is
   * exactly the race the refund's own `status !== "pending"` check exists to lose safely.
   */
  raced: number;
  /** Rows whose release threw. Reported, never swallowed; the next run tries again. */
  failed: number;
  olderThanMs: number;
  dryRun: boolean;
  /** What was (or would be) released, for the operator reading the run. Capped for the log's sake. */
  sample: StaleReservationRow[];
};

const SAMPLE_LIMIT = 20;

/**
 * Find reservations still pending past the cutoff and refund them.
 *
 * Idempotent, and safe to run concurrently with a live job: the release goes through
 * `failAndRefundLedger`, which re-reads the row inside a transaction and returns without touching
 * anything unless it is still `pending`. A run that finishes a second after this one scanned keeps
 * its charge.
 *
 * `dryRun` reads and reports and writes nothing — a real dry run, not the flag-shaped no-op the
 * other credit jobs used to have.
 *
 * Errors: a single row's failure is counted and the sweep continues; DB failures on the scan
 * itself propagate to the caller, which records them against the job.
 */
export async function releaseStaleReservations(params?: {
  now?: Date;
  olderThanMs?: number;
  limit?: number;
  dryRun?: boolean;
}): Promise<ReleaseStaleReservationsResult> {
  const now = params?.now ?? new Date();
  const olderThanMs =
    Number.isFinite(params?.olderThanMs) && (params?.olderThanMs as number) > 0
      ? Math.floor(params!.olderThanMs as number)
      : STALE_PENDING_MS;
  const limit = Number.isFinite(params?.limit) && (params?.limit as number) >= 1 ? Math.floor(params!.limit as number) : DEFAULT_LIMIT;
  const dryRun = params?.dryRun === true;
  const cutoff = new Date(now.getTime() - olderThanMs);

  await connectMongo();

  // Oldest first, so a backlog drains in a stable order across runs rather than the newest rows
  // starving the ones that have been stuck longest.
  const rows = (await CreditLedgerModel.find({ status: "pending", eventType: "ai_run", createdDate: { $lt: cutoff } })
    .sort({ createdDate: 1 })
    .limit(limit)
    .select({ workspaceId: 1, actionType: 1, creditsReserved: 1, createdDate: 1 })
    .lean()) as Array<{
    _id: Types.ObjectId;
    workspaceId?: unknown;
    actionType?: unknown;
    creditsReserved?: unknown;
    createdDate?: unknown;
  }>;

  const result: ReleaseStaleReservationsResult = {
    scanned: rows.length,
    released: 0,
    creditsReturned: 0,
    raced: 0,
    failed: 0,
    olderThanMs,
    dryRun,
    sample: [],
  };

  for (const row of rows) {
    const ledgerId = String(row._id);
    const workspaceId = row.workspaceId ? String(row.workspaceId) : "";
    const creditsReserved = Number(row.creditsReserved) || 0;
    const createdMs = row.createdDate instanceof Date ? row.createdDate.getTime() : now.getTime();
    const describe: StaleReservationRow = {
      ledgerId,
      workspaceId,
      actionType: typeof row.actionType === "string" ? row.actionType : "unknown",
      creditsReserved,
      ageMs: now.getTime() - createdMs,
    };

    if (!Types.ObjectId.isValid(workspaceId)) {
      // A row that names no workspace cannot be refunded to one. Counted, not silently dropped.
      result.failed += 1;
      continue;
    }

    if (dryRun) {
      result.released += 1;
      result.creditsReturned += creditsReserved;
      if (result.sample.length < SAMPLE_LIMIT) result.sample.push(describe);
      continue;
    }

    try {
      await failAndRefundLedger({ workspaceId, ledgerId });
      // Did it take? The refund is a no-op on a row that settled in the meantime, and counting it
      // as released would report credits back that nobody gave back.
      const after = (await CreditLedgerModel.findById(ledgerId).select({ status: 1 }).lean()) as { status?: unknown } | null;
      if (after && after.status === "failed") {
        result.released += 1;
        result.creditsReturned += creditsReserved;
        if (result.sample.length < SAMPLE_LIMIT) result.sample.push(describe);
      } else {
        result.raced += 1;
      }
    } catch {
      // One bad row must not end the sweep; the next run picks it up again.
      result.failed += 1;
    }
  }

  return result;
}
