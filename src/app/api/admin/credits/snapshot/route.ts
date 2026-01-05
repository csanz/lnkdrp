/**
 * Admin API route: `GET /api/admin/credits/snapshot?workspaceId=...`
 *
 * Returns the full credits snapshot for a workspace, plus admin-only subscription metadata
 * (plan, Stripe subscription id, computed cycleKey).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { buildCycleKey } from "@/lib/credits/grants";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null, email: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1, email: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  const email = typeof (u as any)?.email === "string" ? String((u as any).email) : null;
  return { ok: true as const, userId: actor.userId, email };
}

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


