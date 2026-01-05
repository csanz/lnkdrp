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

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const qRaw = url.searchParams.get("q") ?? "";
  const q = qRaw.trim();
  const statusRaw = (url.searchParams.get("status") ?? "").trim(); // draft|preparing|ready|failed|""
  const archivedRaw = (url.searchParams.get("archived") ?? "").trim(); // "yes"|"no"|""
  const sortRaw = (url.searchParams.get("sort") ?? "").trim(); // updatedDate|createdDate
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase(); // asc|desc

  await connectMongo();

  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
  };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ title: rx }, { shareId: rx }];
  }
  if (statusRaw) {
    const allowed = new Set(["draft", "preparing", "ready", "failed"]);
    if (!allowed.has(statusRaw)) {
      return NextResponse.json({ error: "status must be one of: draft | preparing | ready | failed" }, { status: 400 });
    }
    filter.status = statusRaw;
  }
  if (archivedRaw) {
    if (archivedRaw !== "yes" && archivedRaw !== "no") {
      return NextResponse.json({ error: "archived must be one of: yes | no" }, { status: 400 });
    }
    filter.isArchived = archivedRaw === "yes";
  }

  const sortField = sortRaw === "createdDate" ? "createdDate" : "updatedDate";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await DocModel.countDocuments(filter);
  const items = await DocModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
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
    status: statusRaw || null,
    archived: archivedRaw || null,
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
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




