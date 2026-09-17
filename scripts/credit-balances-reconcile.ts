/**
 * One-off reconcile for workspace credit balances after the starter-credit seeding fix.
 *
 * Two historical inconsistencies are corrected:
 * 1. Free team workspaces seeded while starter credits were personal-only (until 2026-09-17) got 0.
 *    Every Free workspace now starts with FREE_STARTER_CREDITS, so a Free team workspace with 0
 *    trial credits and no AI run ever charged or pending is given the grant it would get today.
 *    A workspace that has already spent anything is left alone.
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
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";

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

  let granted = 0;
  let capped = 0;
  let tiersReset = 0;
  for (const row of rows) {
    const org = (await OrgModel.findById(row.workspaceId).select({ type: 1 }).lean()) as { type?: string } | null;
    const plan = await getWorkspacePlan(row.workspaceId);
    const isPersonal = org?.type === "personal";
    const trial = Math.max(0, Math.floor(Number(row.trialCreditsRemaining ?? 0)));

    if (!isPersonal && plan !== "pro" && trial === 0 && FREE_STARTER_CREDITS > 0) {
      const spent = await CreditLedgerModel.exists({
        workspaceId: row.workspaceId,
        eventType: "ai_run",
        status: { $in: ["charged", "pending"] },
      });
      if (!spent) {
        granted += 1;
        console.log(`[reconcile] ${String(row.workspaceId)} Free team workspace with 0 starter credits and no AI runs -> ${FREE_STARTER_CREDITS}`);
        if (apply) {
          await WorkspaceCreditBalanceModel.updateOne(
            { workspaceId: row.workspaceId, trialCreditsRemaining: 0 },
            { $set: { trialCreditsRemaining: FREE_STARTER_CREDITS } },
          );
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

  console.log(`[reconcile] scanned ${rows.length} balance rows; starter credits granted: ${granted}; daily caps set: ${capped}; compare tiers reset: ${tiersReset}; ${apply ? "applied" : "dry run (pass --apply)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
