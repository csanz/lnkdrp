/**
 * Admin API route: `POST /api/admin/credits/simulate-cycle`
 *
 * Admin/test-only helper to simulate a new Stripe billing cycle for a workspace:
 * - Updates stored subscription period boundaries (does NOT call Stripe)
 * - Calls `grantCycleIncludedCredits()` idempotently for the computed cycleKey
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { adminSimulateNewBillingCycle } from "@/lib/credits/adminMutations";

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

function asPositiveInt(v: unknown, opts?: { max?: number }): number | null {
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return null;
  if (i > max) return null;
  return i;
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!Types.ObjectId.isValid(workspaceId)) {
    return NextResponse.json({ error: "workspaceId is required (Mongo ObjectId)" }, { status: 400 });
  }

  const start = asPositiveInt(body?.newPeriodStartUnixSeconds, { max: 4_102_444_800 });
  const end = asPositiveInt(body?.newPeriodEndUnixSeconds, { max: 4_102_444_800 });
  if (!start || !end) {
    return NextResponse.json({ error: "newPeriodStartUnixSeconds and newPeriodEndUnixSeconds are required unix seconds" }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ error: "newPeriodEndUnixSeconds must be > newPeriodStartUnixSeconds" }, { status: 400 });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "reason is required" }, { status: 400 });

  try {
    const res = await adminSimulateNewBillingCycle({
      workspaceId,
      newPeriodStartUnixSeconds: start,
      newPeriodEndUnixSeconds: end,
      reason,
      actorUserId: auth.userId,
      actorEmail: auth.email,
    });
    return NextResponse.json({ ok: true, cycleKey: res.cycleKey, snapshot: res.snapshot });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}


