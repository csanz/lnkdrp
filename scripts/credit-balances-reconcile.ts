/**
 * One-off reconcile for workspace credit balances after the starter-credit seeding fix.
 *
 * Two historical inconsistencies are corrected:
 * 1. Team (non-personal) workspaces whose balance row was seeded by the dashboard snapshot got the
 *    50 Free starter credits meant only for personal workspaces. Rows with no charged ledger
 *    activity are reset to 0 trial credits (a workspace that already spent some keeps them).
 * 2. Free workspaces seeded before the daily brake existed have `dailyCreditCap: null`; they get
 *    the same 15/day cap new Free workspaces get. Pro workspaces are never touched.
 *
 * 3. With `--reset-compare-tier`: Free workspaces whose stored compare tier is "standard" (the old
 *    schema default, indistinguishable from an explicit choice) go back to "follow the plan", which
 *    is Basic on Free. Opt-in because it overrides what may have been a deliberate setting.
 *
 * Usage:
 * - Dry run (default):  tsx --env-file=.env.local scripts/credit-balances-reconcile.ts
 * - Apply:              tsx --env-file=.env.local scripts/credit-balances-reconcile.ts --apply
 * - Also reset tiers:    tsx --env-file=.env.local scripts/credit-balances-reconcile.ts --apply --reset-compare-tier
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { FREE_DAILY_CREDIT_CAP } from "@/lib/credits/creditService";

async function main() {
  const apply = process.argv.includes("--apply");
  const resetCompareTier = process.argv.includes("--reset-compare-tier");
  await connectMongo();

  const rows = (await WorkspaceCreditBalanceModel.find({})
    .select({ workspaceId: 1, trialCreditsRemaining: 1, dailyCreditCap: 1, defaultHistoryQualityTier: 1 })
    .lean()) as Array<{
    workspaceId: Types.ObjectId;
    trialCreditsRemaining?: number;
    dailyCreditCap?: number | null;
    defaultHistoryQualityTier?: string | null;
  }>;

  let zeroed = 0;
  let capped = 0;
  let tiersReset = 0;
  for (const row of rows) {
    const org = (await OrgModel.findById(row.workspaceId).select({ type: 1 }).lean()) as { type?: string } | null;
    const plan = await getWorkspacePlan(row.workspaceId);
    const isPersonal = org?.type === "personal";
    const trial = Math.max(0, Math.floor(Number(row.trialCreditsRemaining ?? 0)));

    if (!isPersonal && trial > 0) {
      const spent = await CreditLedgerModel.exists({
        workspaceId: row.workspaceId,
        eventType: "ai_run",
        status: { $in: ["charged", "pending"] },
      });
      if (!spent) {
        zeroed += 1;
        console.log(`[reconcile] ${String(row.workspaceId)} team workspace with ${trial} unspent starter credits -> 0`);
        if (apply) {
          await WorkspaceCreditBalanceModel.updateOne({ workspaceId: row.workspaceId }, { $set: { trialCreditsRemaining: 0 } });
        }
      }
    }

    if (resetCompareTier && plan !== "pro" && row.defaultHistoryQualityTier === "standard") {
      tiersReset += 1;
      console.log(`[reconcile] ${String(row.workspaceId)} Free workspace compare tier standard -> follow plan (basic)`);
      if (apply) {
        await WorkspaceCreditBalanceModel.updateOne({ workspaceId: row.workspaceId }, { $set: { defaultHistoryQualityTier: null } });
      }
    }

    if (plan !== "pro" && (row.dailyCreditCap === null || row.dailyCreditCap === undefined)) {
      capped += 1;
      console.log(`[reconcile] ${String(row.workspaceId)} Free workspace without a daily cap -> ${FREE_DAILY_CREDIT_CAP}/day`);
      if (apply) {
        await WorkspaceCreditBalanceModel.updateOne({ workspaceId: row.workspaceId }, { $set: { dailyCreditCap: FREE_DAILY_CREDIT_CAP } });
      }
    }
  }

  console.log(`[reconcile] scanned ${rows.length} balance rows; starter credits zeroed: ${zeroed}; daily caps set: ${capped}; compare tiers reset: ${tiersReset}; ${apply ? "applied" : "dry run (pass --apply)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
