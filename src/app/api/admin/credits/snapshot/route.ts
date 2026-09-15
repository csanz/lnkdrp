/**
 * Admin API route: `GET /api/admin/credits/snapshot?workspaceId=...`
 *
 * Returns the full credits snapshot for a workspace, plus admin-only subscription metadata
 * (plan, Stripe subscription id, computed cycleKey).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { buildCycleKey } from "@/lib/credits/grants";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim();
  if (!Types.ObjectId.isValid(workspaceId)) {
    return NextResponse.json({ error: "workspaceId is required (Mongo ObjectId)" }, { status: 400 });
  }

  await connectMongo();

  const orgId = new Types.ObjectId(workspaceId);
  const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
    .select({ planName: 1, status: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
    .lean();

  const stripeSubscriptionId =
    typeof (sub as any)?.stripeSubscriptionId === "string" ? String((sub as any).stripeSubscriptionId) : null;
  const currentPeriodStart = (sub as any)?.currentPeriodStart instanceof Date ? (sub as any).currentPeriodStart : null;
  const currentPeriodEnd = (sub as any)?.currentPeriodEnd instanceof Date ? (sub as any).currentPeriodEnd : null;

  const cycleKey =
    stripeSubscriptionId && currentPeriodStart ? buildCycleKey({ stripeSubscriptionId, currentPeriodStart }) : null;

  const snapshot = await getCreditsSnapshot({ workspaceId });
  const onDemandLimitCredits = Math.max(0, Math.floor(snapshot.onDemandMonthlyLimitCents / USD_CENTS_PER_CREDIT));

  return NextResponse.json({
    ok: true,
    workspaceId,
    plan: typeof (sub as any)?.planName === "string" ? String((sub as any).planName) : "Unknown",
    stripeSubscriptionId,
    currentPeriodStart: currentPeriodStart ? currentPeriodStart.toISOString() : null,
    currentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
    cycleKey,
    onDemandLimitCredits,
    snapshot,
  });
}


