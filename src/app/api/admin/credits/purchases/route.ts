/**
 * Admin API route: `GET /api/admin/credits/purchases`
 *
 * Read-only view of what workspaces have paid for credits, in two parts:
 *
 * - `purchases`: recent `CreditPurchase` rows — pack, amount, purchase date, expiry, and whether the
 *   expiry job has already taken the unspent credits back.
 * - `onDemand`: on-demand (metered) credits billed, grouped by workspace. Scoped to one workspace it
 *   is that workspace's current billing cycle, read from the `UsageAggCycle` pre-aggregate; fleet-wide
 *   it is a rolling window, because every workspace's cycle starts on a different day and there is no
 *   single "this cycle" across all of them.
 *
 * Optional `?workspaceId=` scopes both parts.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { cycleKeyForUsage, usageCycleStart } from "@/lib/credits/cycleKey";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { asNumber, isPurchasePastExpiry } from "@/lib/admin/creditsAdmin";

export const runtime = "nodejs";

/** Positive integer from a query param, or null. */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

type PurchaseLean = {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId;
  packId?: string;
  credits?: number;
  amountCents?: number;
  currency?: string;
  stripeCheckoutSessionId?: string;
  purchasedAt?: Date;
  expiresAt?: Date;
  expiredAt?: Date | null;
  creditsExpired?: number;
};

/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 25, 200);
  const days = Math.min(asPositiveInt(url.searchParams.get("days")) ?? 30, 365);
  const workspaceIdRaw = (url.searchParams.get("workspaceId") ?? "").trim();
  if (workspaceIdRaw && !Types.ObjectId.isValid(workspaceIdRaw)) {
    return NextResponse.json({ error: "workspaceId must be a Mongo ObjectId" }, { status: 400 });
  }
  const orgId = workspaceIdRaw ? new Types.ObjectId(workspaceIdRaw) : null;

  await connectMongo();

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Scoped: `{ orgId, expiredAt, purchasedAt }` covers the orgId prefix. Fleet-wide there is no
  // index starting at `purchasedAt`, so newest-first comes from `_id` (monotonic with insertion).
  const purchaseFilter: Record<string, unknown> = orgId ? { orgId } : {};
  const purchaseSort: Record<string, -1> = orgId ? { purchasedAt: -1 } : { _id: -1 };

  const [purchaseRows, onDemandGroups] = await Promise.all([
    CreditPurchaseModel.find(purchaseFilter)
      .sort(purchaseSort)
      .limit(limit)
      .select({
        orgId: 1,
        packId: 1,
        credits: 1,
        amountCents: 1,
        currency: 1,
        stripeCheckoutSessionId: 1,
        purchasedAt: 1,
        expiresAt: 1,
        expiredAt: 1,
        creditsExpired: 1,
      })
      .lean() as Promise<PurchaseLean[]>,
    // `{ status, eventType, stripeUsageReportedAt, creditsFromOnDemand, createdDate }` gives the
    // status+eventType prefix; the date bound keeps the scan bounded whatever the ledger's size.
    CreditLedgerModel.aggregate<{ _id: Types.ObjectId; credits: number; runs: number }>([
      {
        $match: {
          eventType: "ai_run",
          status: "charged",
          creditsFromOnDemand: { $gt: 0 },
          createdDate: { $gte: since },
          ...(orgId ? { workspaceId: orgId } : {}),
        },
      },
      { $group: { _id: "$workspaceId", credits: { $sum: "$creditsFromOnDemand" }, runs: { $sum: 1 } } },
      { $sort: { credits: -1 } },
      { $limit: 20 },
    ]),
  ]);

  // Scoped to one workspace, the exact cycle total is a unique-index hit on UsageAggCycle. The
  // key is the *usage* key (`cycleKeyForUsage`: workspace id + the balance row's period start, or
  // the UTC month when there is no Stripe period), which is what the charging path files rows
  // under. This used to build the *grant* key (`buildCycleKey`, Stripe subscription id + unix
  // start) and so never matched a row: every workspace's cycle total read 0 here.
  let cycle: { cycleKey: string; onDemandUsedCredits: number; totalUsedCredits: number } | null = null;
  let cycleUnavailableReason: string | null = null;
  if (orgId) {
    const balance = await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
      .select({ currentPeriodStart: 1 })
      .lean();
    if (balance) {
      const cycleStart = usageCycleStart(balance.currentPeriodStart ?? null);
      const cycleKey = cycleKeyForUsage({ workspaceId: String(orgId), cycleStart });
      const agg = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey })
        .select({ onDemandUsedCredits: 1, totalUsedCredits: 1 })
        .lean();
      cycle = {
        cycleKey,
        onDemandUsedCredits: asNumber(agg?.onDemandUsedCredits),
        totalUsedCredits: asNumber(agg?.totalUsedCredits),
      };
    } else {
      cycleUnavailableReason = "no credit balance row on this workspace yet (it has never run an AI action)";
    }
  }

  const groupOrgIds = onDemandGroups.map((g) => g._id).filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const purchaseOrgIds = purchaseRows.map((p) => p.orgId).filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const orgs = await OrgModel.find({ _id: { $in: [...groupOrgIds, ...purchaseOrgIds] } }).select({ name: 1 }).lean();
  const nameByOrgId = new Map(orgs.map((o) => [String(o._id), typeof o.name === "string" ? o.name : null]));

  const nowMs = now.getTime();

  return NextResponse.json({
    ok: true,
    limit,
    workspaceId: workspaceIdRaw || null,
    purchases: purchaseRows.map((p) => {
      const expiresAt = p.expiresAt instanceof Date ? p.expiresAt : null;
      const expiredAt = p.expiredAt instanceof Date ? p.expiredAt : null;
      const workspaceId = String(p.orgId ?? "");
      return {
        id: String(p._id),
        workspaceId,
        workspaceName: nameByOrgId.get(workspaceId) ?? null,
        packId: typeof p.packId === "string" ? p.packId : null,
        credits: asNumber(p.credits),
        amountCents: asNumber(p.amountCents),
        currency: typeof p.currency === "string" ? p.currency : null,
        stripeCheckoutSessionId: typeof p.stripeCheckoutSessionId === "string" ? p.stripeCheckoutSessionId : null,
        purchasedAt: p.purchasedAt instanceof Date ? p.purchasedAt.toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        expiredAt: expiredAt ? expiredAt.toISOString() : null,
        creditsExpired: asNumber(p.creditsExpired),
        pastExpiry: isPurchasePastExpiry({
          expiresAtMs: expiresAt ? expiresAt.getTime() : null,
          expiredAtMs: expiredAt ? expiredAt.getTime() : null,
          nowMs,
        }),
      };
    }),
    onDemand: {
      windowDays: days,
      since: since.toISOString(),
      /** Exact current-cycle totals; only available when scoped to one workspace. */
      cycle,
      cycleUnavailableReason,
      rows: onDemandGroups.map((g) => {
        const workspaceId = String(g._id);
        return {
          workspaceId,
          workspaceName: nameByOrgId.get(workspaceId) ?? null,
          credits: asNumber(g.credits),
          runs: asNumber(g.runs),
        };
      }),
    },
  });
}
