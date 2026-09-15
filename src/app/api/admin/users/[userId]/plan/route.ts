/**
 * Admin API route: `POST /api/admin/users/:userId/plan`
 *
 * Allows admins (or localhost in dev) to override a user's billing plan in MongoDB.
 * This is intended for testing/ops; official access should be Stripe/webhook-driven.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function POST(request: Request, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { userId } = await ctx.params;
  if (!Types.ObjectId.isValid(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
  const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
  if (plan !== "free" && plan !== "pro") {
    return NextResponse.json({ error: "Invalid plan (expected 'free' or 'pro')" }, { status: 400 });
  }

  await connectMongo();
  const updated = await UserModel.findOneAndUpdate(
    { _id: new Types.ObjectId(userId) },
    { $set: { plan } },
    { new: true, projection: { plan: 1 } },
  ).lean();

  if (!updated) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const updatedPlan = typeof (updated as any)?.plan === "string" ? String((updated as any).plan).trim() : "free";

  return NextResponse.json({ ok: true, plan: updatedPlan });
}


