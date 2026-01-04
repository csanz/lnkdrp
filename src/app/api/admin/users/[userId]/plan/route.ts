/**
 * Admin API route: `POST /api/admin/users/:userId/plan`
 *
 * Allows admins (or localhost in dev) to override a user's billing plan in MongoDB.
 * This is intended for testing/ops; official access should be Stripe/webhook-driven.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

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


