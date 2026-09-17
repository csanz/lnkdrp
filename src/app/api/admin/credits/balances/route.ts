/**
 * Admin API route: `GET /api/admin/credits/balances`
 *
 * Read-only fleet view of `WorkspaceCreditBalance`: one row per workspace with its three buckets
 * (starter / included / purchased), its caps and its on-demand policy, ordered so the workspaces
 * closest to running out come first. Also returns the credit rules in force, read from the
 * constants the product enforces, so the page never hardcodes 50/300/15.
 *
 * Nothing here writes. In particular it does NOT call `getCreditsSnapshot`, which upserts a balance
 * row (seeding the starter grant and the daily cap) as a side effect; a workspace with no balance
 * row simply does not appear in this list.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { FREE_DAILY_CREDIT_CAP } from "@/lib/credits/creditService";
import { PURCHASED_CREDITS_EXPIRY_MONTHS } from "@/lib/credits/packs";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import {
  asNumber,
  balanceAnomalies,
  creditPlanFor,
  totalCreditsRemaining,
  type AdminCreditAnomaly,
  type AdminCreditPlan,
  type CreditRuleLimits,
} from "@/lib/admin/creditsAdmin";

export const runtime = "nodejs";

/** Positive integer from a query param, or null. */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/** One row of the fleet balances table. */
type BalanceRow = {
  workspaceId: string;
  workspaceName: string | null;
  workspaceType: string | null;
  plan: AdminCreditPlan;
  subscriptionStatus: string | null;
  starter: number;
  included: number;
  purchased: number;
  totalRemaining: number;
  dailyCreditCap: number | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  currentPeriodEnd: string | null;
  updatedDate: string | null;
  anomalies: AdminCreditAnomaly[];
};

type BalanceAggRow = {
  _id: Types.ObjectId;
  workspaceId?: Types.ObjectId;
  trialCreditsRemaining?: number;
  subscriptionCreditsRemaining?: number;
  purchasedCreditsRemaining?: number;
  dailyCreditCap?: number | null;
  onDemandEnabled?: boolean;
  onDemandMonthlyLimitCents?: number;
  currentPeriodEnd?: Date | null;
  updatedDate?: Date | null;
  totalRemaining?: number;
};

/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const sortRaw = (url.searchParams.get("sort") ?? "").trim(); // remaining | updated
  const sortField = sortRaw === "updated" ? "updated" : "remaining";

  // The sort is on a computed total (three buckets added together), so no index can serve it and
  // Mongo has to sort the whole collection in memory. `$project` first keeps the documents small,
  // and the page window is capped so a deep page cannot turn into an unbounded scan.
  //
  // `maxWindow` goes back on the wire because `total` alone does not tell a pager where the pages
  // stop: past this many rows every page 400s, so a Next button sized from `total` walks into an
  // error instead of the last page.
  const MAX_WINDOW = 2000;
  const skip = (page - 1) * limit;
  if (skip + limit > MAX_WINDOW) {
    return NextResponse.json({ error: `page is out of range (max ${MAX_WINDOW} rows)` }, { status: 400 });
  }

  await connectMongo();

  const total = await WorkspaceCreditBalanceModel.countDocuments({});

  const sortStage: Record<string, 1 | -1> =
    sortField === "updated" ? { updatedDate: -1, _id: -1 } : { totalRemaining: 1, _id: 1 };

  const rows = await WorkspaceCreditBalanceModel.aggregate<BalanceAggRow>([
    {
      $project: {
        workspaceId: 1,
        trialCreditsRemaining: 1,
        subscriptionCreditsRemaining: 1,
        purchasedCreditsRemaining: 1,
        dailyCreditCap: 1,
        onDemandEnabled: 1,
        onDemandMonthlyLimitCents: 1,
        currentPeriodEnd: 1,
        updatedDate: 1,
      },
    },
    {
      $addFields: {
        totalRemaining: {
          $add: [
            { $ifNull: ["$trialCreditsRemaining", 0] },
            { $ifNull: ["$subscriptionCreditsRemaining", 0] },
            { $ifNull: ["$purchasedCreditsRemaining", 0] },
          ],
        },
      },
    },
    { $sort: sortStage },
    { $skip: skip },
    { $limit: limit },
  ]);

  const orgIds = rows
    .map((r) => r.workspaceId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);

  // Two `$in` lookups over the page's ids, never one query per row.
  const [orgs, subs] = await Promise.all([
    OrgModel.find({ _id: { $in: orgIds } }).select({ name: 1, type: 1 }).lean(),
    SubscriptionModel.find({ orgId: { $in: orgIds }, isDeleted: { $ne: true } })
      .select({ orgId: 1, status: 1, kind: 1 })
      .lean(),
  ]);

  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const subByOrgId = new Map(subs.map((s) => [String(s.orgId), s]));

  const limits: CreditRuleLimits = {
    starterGrant: FREE_STARTER_CREDITS,
    includedPerCycle: INCLUDED_CREDITS_PER_CYCLE,
    freeDailyCap: FREE_DAILY_CREDIT_CAP,
  };

  const balances: BalanceRow[] = rows.map((r) => {
    const workspaceId = String(r.workspaceId ?? r._id);
    const org = orgById.get(workspaceId);
    const sub = subByOrgId.get(workspaceId) ?? null;
    const plan = creditPlanFor(sub);
    const buckets = {
      starter: asNumber(r.trialCreditsRemaining),
      included: asNumber(r.subscriptionCreditsRemaining),
      purchased: asNumber(r.purchasedCreditsRemaining),
    };
    const dailyCreditCap = typeof r.dailyCreditCap === "number" ? r.dailyCreditCap : null;
    const onDemandEnabled = r.onDemandEnabled === true;
    const onDemandMonthlyLimitCents = asNumber(r.onDemandMonthlyLimitCents);
    return {
      workspaceId,
      workspaceName: typeof org?.name === "string" ? org.name : null,
      workspaceType: typeof org?.type === "string" ? org.type : null,
      plan,
      subscriptionStatus: typeof sub?.status === "string" ? sub.status : null,
      starter: buckets.starter,
      included: buckets.included,
      purchased: buckets.purchased,
      totalRemaining: totalCreditsRemaining(buckets),
      dailyCreditCap,
      onDemandEnabled,
      onDemandMonthlyLimitCents,
      currentPeriodEnd: r.currentPeriodEnd instanceof Date ? r.currentPeriodEnd.toISOString() : null,
      updatedDate: r.updatedDate instanceof Date ? r.updatedDate.toISOString() : null,
      anomalies: balanceAnomalies({ plan, buckets, dailyCreditCap, onDemandEnabled, onDemandMonthlyLimitCents, limits }),
    };
  });

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    maxWindow: MAX_WINDOW,
    sort: sortField,
    rules: {
      starterGrant: FREE_STARTER_CREDITS,
      includedPerCycle: INCLUDED_CREDITS_PER_CYCLE,
      freeDailyCap: FREE_DAILY_CREDIT_CAP,
      purchaseExpiryMonths: PURCHASED_CREDITS_EXPIRY_MONTHS,
      usdCentsPerCredit: USD_CENTS_PER_CREDIT,
    },
    balances,
  });
}
