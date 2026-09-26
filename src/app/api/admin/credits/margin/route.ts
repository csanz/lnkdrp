/**
 * Admin API route: `GET /api/admin/credits/margin?days=7[&workspaceId=]`
 *
 * What each AI action charged against what it cost us, for a window. The one report that puts a
 * credit price and a dollar cost on the same line, per action type and per model, so a feature
 * priced above or below what it costs is visible instead of assumed.
 *
 * Rows charged before 2026-09-26 carry no `costUsdActual`, because nothing wrote the field then.
 * They do carry their tokens and the model that ran, so their cost is arithmetic rather than a
 * guess, and this route computes it while reading instead of back-filling the ledger: a stored
 * number would claim to have been true at charge time, and it would be priced at today's rates.
 * Those runs are counted in `estimatedRuns` so the page can say how much of a total rests on them.
 * Nothing here writes.
 *
 * Internal by construction: `costUsdActual` and the token columns are our cost, never a customer's
 * price, and they are contractually absent from every customer-facing API.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { AiRunModel } from "@/lib/models/AiRun";
import { MODEL_PRICES_AS_OF, costUsdForUsage, pricedModelIds } from "@/lib/ai/modelPricing";
import {
  LIST_RATE_USD_PER_CREDIT,
  marginRow,
  marginTotal,
  type MarginBucketSums,
  type AllAiRunSpend,
} from "@/lib/credits/marginReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [1, 7, 30, 90] as const;

/**
 * The window, expressed as an `_id` lower bound rather than a `createdDate` one.
 *
 * There is no fleet-wide index starting at `createdDate` on the ledger, so filtering on it would
 * be a blocking scan of the whole collection. `_id` is monotonic with insertion time and always
 * indexed, and a ledger row is inserted at reservation, which is seconds before the charge it
 * carries. That is close enough for a spend report and free to query.
 */
function idSince(since: Date): Types.ObjectId {
  return Types.ObjectId.createFromTime(Math.floor(since.getTime() / 1000));
}

/**
 * One `$group` bucket: an action, a model, and whether its rows already carry a stored cost.
 *
 * Grouping on `priced` as well as on the action and the model is what lets the unpriced rows be
 * costed exactly without loading them. Token prices are linear, so pricing the bucket's summed
 * tokens at the bucket's single model gives the same dollars as pricing each row and adding them.
 */
type Bucket = {
  _id: { action: string | null; model: string | null; priced: boolean };
  runs: number;
  creditsCharged: number;
  costUsd: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedInputTokens: number | null;
};

/** The `$group` body every breakdown shares. */
const GROUP_SUMS = {
  runs: { $sum: 1 },
  creditsCharged: { $sum: { $ifNull: ["$creditsCharged", 0] } },
  costUsd: { $sum: { $ifNull: ["$costUsdActual", 0] } },
  promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
  completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
  cachedInputTokens: { $sum: { $ifNull: ["$cachedInputTokens", 0] } },
} as const;

/** A number from an aggregation result, defaulting to 0 rather than NaN. */
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** An empty bucket to accumulate into. */
function emptySums(key: string): MarginBucketSums {
  return {
    key,
    runs: 0,
    creditsCharged: 0,
    pricedRuns: 0,
    pricedCredits: 0,
    costUsd: 0,
    estimatedRuns: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/**
 * Fold the raw buckets into report rows, keyed by whatever `keyOf` picks out.
 *
 * A bucket already carrying stored costs is added as it stands. One without them is priced here
 * from its own summed tokens, and only when its model is a single id the price table knows: a
 * bucket whose rows never recorded a model, or recorded a model we cannot price, contributes its
 * runs and its credits and no dollars, so it shows up under "not priced" rather than as free.
 */
function foldBuckets(buckets: readonly Bucket[], keyOf: (b: Bucket) => string): MarginBucketSums[] {
  const byKey = new Map<string, MarginBucketSums>();
  for (const b of buckets) {
    const key = keyOf(b);
    const acc = byKey.get(key) ?? emptySums(key);
    const runs = n(b.runs);
    const credits = n(b.creditsCharged);
    acc.runs += runs;
    acc.creditsCharged += credits;
    acc.promptTokens += n(b.promptTokens);
    acc.completionTokens += n(b.completionTokens);

    if (b._id.priced) {
      acc.pricedRuns += runs;
      acc.pricedCredits += credits;
      acc.costUsd += n(b.costUsd);
    } else {
      const usd = costUsdForUsage({
        model: b._id.model,
        promptTokens: b.promptTokens,
        completionTokens: b.completionTokens,
        cachedInputTokens: b.cachedInputTokens,
      });
      if (usd !== null) {
        acc.pricedRuns += runs;
        acc.pricedCredits += credits;
        acc.costUsd += usd;
        acc.estimatedRuns += runs;
      }
    }
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Every AI run in the window and what it cost, read from the AiRun log rather than the ledger.
 *
 * The `$match` is the window and nothing else, so this is *total* AI-run spend: the runs the
 * margin table already bills for are in it too. It is not an unbilled figure and must not be added
 * to the table's cost, which would count the same dollars twice. Telling the two apart would need
 * a link between the collections and there is none - no `aiRunId` on `CreditLedger`, no
 * `creditLedgerId` on `AiRun` - so this reports the total and lets the reader compare.
 *
 * Read it as a second measure of the same spend: a total materially above the table's cost is the
 * unbilled remainder (a refunded failure, a recipient upload, an agent's own summary), and a total
 * materially below it means runs are being charged for that the AiRun log never saw. Compares are
 * the known case of the latter: `runDocChangeDiff` records no AiRun at all.
 *
 * `failedRuns` and `failedCostUsd` are filtered on `status` and are genuinely unbilled.
 */
async function allAiRunSpend(since: Date): Promise<AllAiRunSpend> {
  const rows = await AiRunModel.aggregate<{
    _id: null;
    runs: number;
    pricedRuns: number;
    costUsd: number;
    failedRuns: number;
    failedCostUsd: number;
  }>([
    { $match: { createdDate: { $gte: since } } },
    {
      $group: {
        _id: null,
        runs: { $sum: 1 },
        pricedRuns: { $sum: { $cond: [{ $gt: ["$costUsdActual", null] }, 1, 0] } },
        costUsd: { $sum: { $ifNull: ["$costUsdActual", 0] } },
        failedRuns: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        failedCostUsd: {
          $sum: { $cond: [{ $eq: ["$status", "failed"] }, { $ifNull: ["$costUsdActual", 0] }, 0] },
        },
      },
    },
  ]);
  const r = rows[0];
  return {
    runs: n(r?.runs),
    pricedRuns: n(r?.pricedRuns),
    costUsd: n(r?.costUsd),
    failedRuns: n(r?.failedRuns),
    failedCostUsd: n(r?.failedCostUsd),
  };
}

/**
 * Serves the margin report for `/a/credits`.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const daysRaw = Number(url.searchParams.get("days") ?? 7);
  const days = (ALLOWED_DAYS as readonly number[]).includes(daysRaw) ? daysRaw : 7;
  const workspaceIdRaw = (url.searchParams.get("workspaceId") ?? "").trim();
  if (workspaceIdRaw && !Types.ObjectId.isValid(workspaceIdRaw)) {
    return NextResponse.json({ error: "workspaceId must be a Mongo ObjectId" }, { status: 400 });
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  await connectMongo();

  const match: Record<string, unknown> = {
    _id: { $gte: idSince(since) },
    eventType: "ai_run",
    status: "charged",
  };
  if (workspaceIdRaw) match.workspaceId = new Types.ObjectId(workspaceIdRaw);

  const [buckets, aiRunSpend] = await Promise.all([
    CreditLedgerModel.aggregate<Bucket>([
      { $match: match },
      {
        $group: {
          _id: {
            action: { $ifNull: ["$actionType", "unknown"] },
            model: "$modelRoute",
            // `$gt` against null is the aggregation idiom for "this field holds a value": null and
            // a missing field both sort below every number.
            priced: { $gt: ["$costUsdActual", null] },
          },
          ...GROUP_SUMS,
        },
      },
    ]),
    // Fleet-wide, and unscoped in a second way too: an AiRun row carries no workspace id, only a
    // user id, so `workspaceId` cannot narrow it the way it narrows the ledger. Reported as such
    // rather than filtered wrongly.
    allAiRunSpend(since),
  ]);

  const byAction = foldBuckets(buckets, (b) => b._id.action ?? "unknown");
  const byModel = foldBuckets(buckets, (b) => b._id.model ?? "not recorded");

  return NextResponse.json({
    ok: true,
    days,
    since: since.toISOString(),
    workspaceId: workspaceIdRaw || null,
    listRateUsdPerCredit: LIST_RATE_USD_PER_CREDIT,
    /** So the page can say how old the prices behind every dollar on it are. */
    pricesAsOf: MODEL_PRICES_AS_OF,
    pricedModels: pricedModelIds(),
    byAction: byAction.map(marginRow),
    byModel: byModel.map(marginRow),
    total: marginTotal(byAction),
    /** Total AI-run spend, fleet-wide. Overlaps `total.costUsd`; see `AllAiRunSpend`. */
    aiRunSpend,
  });
}
