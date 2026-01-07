/**
 * Index to keep on-demand usage lookups snappy.
 *
 * Targets:
 * - `/api/billing/spend` fallback aggregate when `UsageAggCycle` rows are missing.
 *
 * Query shape:
 * - CreditLedger.aggregate([
 *   { $match: { workspaceId, eventType:"ai_run", status:"charged", cycleKey, creditsFromOnDemand:{ $gt:0 } } },
 *   { $group: { _id:null, sum:{ $sum:"$creditsFromOnDemand" } } }
 * ])
 *
 * Notes:
 * - Partial index keeps the index small and focused on the hot path.
 * - Safe to run multiple times (createIndex is idempotent).
 */
export async function up({ db }) {
  await db.collection("creditledgers").createIndex(
    { workspaceId: 1, eventType: 1, status: 1, cycleKey: 1, creditsFromOnDemand: 1 },
    {
      partialFilterExpression: {
        eventType: "ai_run",
        status: "charged",
        cycleKey: { $type: "string" },
        creditsFromOnDemand: { $gt: 0 },
      },
    },
  );
}


