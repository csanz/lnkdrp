/**
 * Admin API route: `GET /api/admin/credits/anomalies`
 *
 * Read-only sweep for credit rows that contradict today's rules. Each rule and the reason it is
 * suspicious live in `@/lib/admin/creditsAdmin`; this route only finds the candidates cheaply.
 *
 * Coverage is deliberate, not exhaustive: every query below is bounded and index-backed, and the
 * response reports how many rows each pass looked at plus whether it hit its cap, so an empty list
 * is never mistaken for "the fleet is clean".
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { FREE_DAILY_CREDIT_CAP } from "@/lib/credits/creditService";
import { PRO_KIND_FILTER } from "@/lib/billing/subscriptionState";
import {
  STALE_PENDING_MS,
  asNumber,
  balanceAnomalies,
  creditPlanFor,
  fmtAge,
  fmtCredits,
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

type AnomalyItem = AdminCreditAnomaly & {
  workspaceId: string;
  workspaceName: string | null;
  plan: AdminCreditPlan | null;
  /** When the offending row was last written, where the source has a timestamp. */
  at: string | null;
};

type BalanceLean = {
  _id: Types.ObjectId;
  workspaceId?: Types.ObjectId;
  trialCreditsRemaining?: number;
  subscriptionCreditsRemaining?: number;
  purchasedCreditsRemaining?: number;
  dailyCreditCap?: number | null;
  onDemandEnabled?: boolean;
  onDemandMonthlyLimitCents?: number;
  updatedDate?: Date;
};

const BALANCE_SELECT = {
  workspaceId: 1,
  trialCreditsRemaining: 1,
  subscriptionCreditsRemaining: 1,
  purchasedCreditsRemaining: 1,
  dailyCreditCap: 1,
  onDemandEnabled: 1,
  onDemandMonthlyLimitCents: 1,
  updatedDate: 1,
} as const;

/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const scan = Math.min(asPositiveInt(url.searchParams.get("scan")) ?? 300, 1000);

  await connectMongo();

  const now = new Date();
  const nowMs = now.getTime();
  const pendingCutoff = new Date(nowMs - STALE_PENDING_MS);

  const limits: CreditRuleLimits = {
    starterGrant: FREE_STARTER_CREDITS,
    includedPerCycle: INCLUDED_CREDITS_PER_CYCLE,
    freeDailyCap: FREE_DAILY_CREDIT_CAP,
  };

  const [impossibleRows, leftoverRows, proSubs, pendingRows, overduePurchases] = await Promise.all([
    // Pass 1a: values the writing code could not have produced at all — a negative bucket, or more
    // starter credits than the one-time grant. These match nothing on a healthy workspace, so the
    // cap is effectively never reached and a real corruption is always in the result.
    //
    // Split from 1b on purpose. Both used to share one `$or` under one cap, but the 1b clauses match
    // every healthy Pro workspace, so on a fleet with more Pro workspaces than `scan` the cap filled
    // with normal rows and a negative balance — the one anomaly that blocks a workspace outright —
    // could sit past the limit and never be reported.
    WorkspaceCreditBalanceModel.find({
      $or: [
        { trialCreditsRemaining: { $lt: 0 } },
        { subscriptionCreditsRemaining: { $lt: 0 } },
        { purchasedCreditsRemaining: { $lt: 0 } },
        { trialCreditsRemaining: { $gt: FREE_STARTER_CREDITS } },
        { subscriptionCreditsRemaining: { $gt: INCLUDED_CREDITS_PER_CYCLE } },
      ],
    })
      .limit(scan)
      .select(BALANCE_SELECT)
      .lean() as Promise<BalanceLean[]>,

    // Pass 1b: values that are normal on Pro and leftovers off it — included credits held, and the
    // on-demand toggle. Only the plan lookup below can tell the two apart, so this matches every Pro
    // workspace by design and carries its own cap. The `dailyCreditCap` rule is in neither `$or`:
    // every Free row carries a cap, so it would match the whole collection; it is driven from the
    // Pro subscription side in pass 2 instead.
    WorkspaceCreditBalanceModel.find({
      $or: [
        { subscriptionCreditsRemaining: { $gt: 0 } },
        { onDemandEnabled: true },
        { onDemandMonthlyLimitCents: { $gt: 0 } },
      ],
    })
      .limit(scan)
      .select(BALANCE_SELECT)
      .lean() as Promise<BalanceLean[]>,

    // Pass 2: workspaces on Pro right now. Their balances are checked for the Free daily brake that
    // the cycle grant should have cleared. Pro workspaces are a small set, so this stays cheap.
    SubscriptionModel.find({ status: { $in: ["active", "trialing"] }, ...PRO_KIND_FILTER, isDeleted: { $ne: true } })
      .limit(scan)
      .select({ orgId: 1, status: 1, kind: 1 })
      .lean(),

    // Reservations that were never settled. `{ status, ... , createdDate }` serves the status prefix.
    CreditLedgerModel.find({ status: "pending", createdDate: { $lt: pendingCutoff } })
      .sort({ _id: -1 })
      .limit(100)
      .select({ workspaceId: 1, actionType: 1, qualityTier: 1, creditsReserved: 1, createdDate: 1 })
      .lean(),

    // Packs the daily expiry job should already have reclaimed; `{ expiredAt, expiresAt }` is this
    // query's own index.
    CreditPurchaseModel.find({ expiredAt: null, expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(100)
      .select({ orgId: 1, packId: 1, credits: 1, expiresAt: 1 })
      .lean(),
  ]);

  // Pro balances that pass 1 may not have returned (a Pro row with 0 included credits and no
  // on-demand matches none of its clauses), so load them by id.
  const proOrgIds = proSubs.map((s) => s.orgId).filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const proBalances = (await WorkspaceCreditBalanceModel.find({ workspaceId: { $in: proOrgIds } })
    .select(BALANCE_SELECT)
    .lean()) as BalanceLean[];

  const byWorkspaceId = new Map<string, BalanceLean>();
  for (const b of [...impossibleRows, ...leftoverRows, ...proBalances]) {
    byWorkspaceId.set(String(b.workspaceId ?? b._id), b);
  }

  const subOrgIds = [...byWorkspaceId.keys()].map((id) => new Types.ObjectId(id));
  const subs = await SubscriptionModel.find({ orgId: { $in: subOrgIds }, isDeleted: { $ne: true } })
    .select({ orgId: 1, status: 1, kind: 1 })
    .lean();
  const subByOrgId = new Map(subs.map((s) => [String(s.orgId), s]));

  const items: AnomalyItem[] = [];
  const planByWorkspaceId = new Map<string, AdminCreditPlan>();

  for (const [workspaceId, b] of byWorkspaceId) {
    const sub = subByOrgId.get(workspaceId) ?? null;
    const plan = creditPlanFor(sub);
    planByWorkspaceId.set(workspaceId, plan);
    const found = balanceAnomalies({
      plan,
      buckets: {
        starter: asNumber(b.trialCreditsRemaining),
        included: asNumber(b.subscriptionCreditsRemaining),
        purchased: asNumber(b.purchasedCreditsRemaining),
      },
      dailyCreditCap: typeof b.dailyCreditCap === "number" ? b.dailyCreditCap : null,
      onDemandEnabled: b.onDemandEnabled === true,
      onDemandMonthlyLimitCents: asNumber(b.onDemandMonthlyLimitCents),
      limits,
    });
    for (const a of found) {
      items.push({
        ...a,
        workspaceId,
        workspaceName: null,
        plan,
        at: b.updatedDate instanceof Date ? b.updatedDate.toISOString() : null,
      });
    }
  }

  for (const r of pendingRows) {
    const workspaceId = String(r.workspaceId ?? "");
    const created = r.createdDate instanceof Date ? r.createdDate : null;
    items.push({
      code: "stale_pending",
      severity: "high",
      reason:
        "A reservation is settled within one AI run; still pending after an hour means the run died and the credits are held against a workspace that cannot spend them.",
      detail: `${typeof r.actionType === "string" ? r.actionType : "unknown"}/${
        typeof r.qualityTier === "string" ? r.qualityTier : "?"
      }, reserved=${fmtCredits(asNumber(r.creditsReserved))}, pending for ${
        created ? fmtAge(nowMs - created.getTime()) : "?"
      }`,
      workspaceId,
      workspaceName: null,
      plan: planByWorkspaceId.get(workspaceId) ?? null,
      at: created ? created.toISOString() : null,
    });
  }

  for (const p of overduePurchases) {
    const workspaceId = String(p.orgId ?? "");
    const expiresAt = p.expiresAt instanceof Date ? p.expiresAt : null;
    items.push({
      code: "purchase_past_expiry",
      severity: "high",
      reason:
        "The daily expiry job stamps `expiredAt` when it reclaims a pack's unspent credits; a live pack past its date means the job has not reached it and the workspace is still spending credits it no longer owns.",
      detail: `${typeof p.packId === "string" ? p.packId : "pack"}, ${fmtCredits(asNumber(p.credits))} credits, due ${
        expiresAt ? fmtAge(nowMs - expiresAt.getTime()) : "?"
      } ago`,
      workspaceId,
      workspaceName: null,
      plan: planByWorkspaceId.get(workspaceId) ?? null,
      at: expiresAt ? expiresAt.toISOString() : null,
    });
  }

  const orgIds = [...new Set(items.map((i) => i.workspaceId))]
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const orgs = await OrgModel.find({ _id: { $in: orgIds } }).select({ name: 1 }).lean();
  const nameByOrgId = new Map(orgs.map((o) => [String(o._id), typeof o.name === "string" ? o.name : null]));
  for (const i of items) i.workspaceName = nameByOrgId.get(i.workspaceId) ?? null;

  // Money-affecting first, then by code so repeats of the same rule read together.
  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  return NextResponse.json({
    ok: true,
    now: now.toISOString(),
    scanned: {
      balanceCandidates: impossibleRows.length + leftoverRows.length,
      // Either pass hitting its cap means there may be more than is shown; the page says so.
      balanceCandidatesTruncated: impossibleRows.length >= scan || leftoverRows.length >= scan,
      proSubscriptions: proSubs.length,
      proSubscriptionsTruncated: proSubs.length >= scan,
      pendingRows: pendingRows.length,
      pendingRowsTruncated: pendingRows.length >= 100,
      overduePurchases: overduePurchases.length,
      overduePurchasesTruncated: overduePurchases.length >= 100,
      stalePendingOlderThanMs: STALE_PENDING_MS,
    },
    items,
  });
}
