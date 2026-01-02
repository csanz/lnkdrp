/**
 * Admin API route: `GET /api/admin/data/docs`
 *
 * Lists docs across all users (paged) for admin inspection.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { DocModel } from "@/lib/models/Doc";

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

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const qRaw = url.searchParams.get("q") ?? "";
  const q = qRaw.trim();

  await connectMongo();

  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
  };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { shareId: rx }];
  }

  const total = await DocModel.countDocuments(filter);
  const items = await DocModel.find(filter)
    .sort({ updatedDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      userId: 1,
      title: 1,
      status: 1,
      shareId: 1,
      isArchived: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    docs: items.map((d) => ({
      id: String(d._id),
      userId: d.userId ? String(d.userId) : null,
      title: typeof d.title === "string" ? d.title : null,
      status: typeof d.status === "string" ? d.status : null,
      shareId: typeof d.shareId === "string" ? d.shareId : null,
      isArchived: Boolean((d as { isArchived?: unknown }).isArchived),
      updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
      createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
    })),
  });
}




