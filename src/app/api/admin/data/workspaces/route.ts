/**
 * Admin API route: `GET /api/admin/data/workspaces`
 *
 * Lists "workspaces" for admin inspection.
 *
 * In this system, a "workspace" is an org (personal or team).
 * This endpoint supports filtering by org type.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
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
  const typeRaw = (url.searchParams.get("type") ?? "").trim(); // personal | team | ""
  const sortRaw = (url.searchParams.get("sort") ?? "").trim(); // createdDate | updatedDate
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase(); // asc | desc

  await connectMongo();

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (typeRaw) {
    const allowed = new Set(["personal", "team"]);
    if (!allowed.has(typeRaw)) {
      return NextResponse.json({ error: "type must be one of: personal | team" }, { status: 400 });
    }
    filter.type = typeRaw;
  } else {
    // Default to team workspaces (common case).
    filter.type = "team";
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }

  const sortField = sortRaw === "updatedDate" ? "updatedDate" : "createdDate";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await OrgModel.countDocuments(filter);
  const orgs = await OrgModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({ type: 1, name: 1, slug: 1, createdDate: 1, updatedDate: 1 })
    .lean();

  const orgIds = orgs
    .map((o) => (o as { _id?: unknown })._id)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);

  const counts = await OrgMembershipModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { orgId: { $in: orgIds }, isDeleted: { $ne: true } } },
    { $group: { _id: "$orgId", n: { $sum: 1 } } },
  ]);
  const countsByOrgId = new Map(counts.map((c) => [String(c._id), Number(c.n) || 0]));

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    type: typeRaw || "team",
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
    workspaces: orgs.map((o) => {
      const workspaceId = String((o as { _id: Types.ObjectId })._id);
      const type = typeof (o as { type?: unknown }).type === "string" ? (o as { type: string }).type : null;
      const name = typeof (o as { name?: unknown }).name === "string" ? (o as { name: string }).name : null;
      const slug = typeof (o as { slug?: unknown }).slug === "string" ? (o as { slug: string }).slug : null;
      const createdDate = (o as { createdDate?: unknown }).createdDate instanceof Date ? o.createdDate.toISOString() : null;
      const updatedDate = (o as { updatedDate?: unknown }).updatedDate instanceof Date ? o.updatedDate.toISOString() : null;
      return { workspaceId, type, name, slug, memberCount: countsByOrgId.get(workspaceId) ?? 0, createdDate, updatedDate };
    }),
  });
}


