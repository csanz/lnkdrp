/**
 * Admin API route: `GET /api/admin/cron-health`
 *
 * Returns latest cron health snapshots (written by cron endpoints).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";
/**
 * Return whether localhost request.
 */


function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}
/**
 * Require Admin (uses isLocalhostRequest, resolveActor, isValid).
 */


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
/**
 * As Positive Int (uses Number, isFinite, floor).
 */


function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}
/**
 * Handle GET requests.
 */


export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = asPositiveInt(url.searchParams.get("limit")) ?? 50;

  await connectMongo();
  const items = await CronHealthModel.find({})
    .sort({ lastRunAt: -1, updatedDate: -1 })
    .limit(Math.min(limit, 200))
    .select({
      jobKey: 1,
      status: 1,
      lastStartedAt: 1,
      lastFinishedAt: 1,
      lastRunAt: 1,
      lastDurationMs: 1,
      lastParams: 1,
      lastResult: 1,
      lastErrorAt: 1,
      lastError: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({ ok: true, items });
}




