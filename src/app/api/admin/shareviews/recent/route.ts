/**
 * Admin API route: `/api/admin/shareviews/recent`
 *
 * Returns the most recent per-viewer ShareView records across all docs.
 * Used by the admin Share Views dashboard.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { ShareViewModel } from "@/lib/models/ShareView";
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
  const limit = asPositiveInt(url.searchParams.get("limit")) ?? 200;

  await connectMongo();

  const items = await ShareViewModel.find({})
    .sort({ updatedDate: -1 })
    .limit(Math.min(limit, 500))
    .select({
      shareId: 1,
      docId: 1,
      pagesSeen: 1,
      downloads: 1,
      downloadsByDay: 1,
      createdDate: 1,
      updatedDate: 1,
      viewerUserId: 1,
      viewerEmail: 1,
      viewerIp: 1,
    })
    .populate({ path: "docId", select: { title: 1, shareId: 1 } })
    .populate({ path: "viewerUserId", select: { email: 1, name: 1 } })
    .lean();

  return NextResponse.json({ ok: true, items });
}


