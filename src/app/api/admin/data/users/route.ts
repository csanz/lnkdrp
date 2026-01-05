/**
 * Admin API route: `GET /api/admin/data/users`
 *
 * Lists users (paged) for admin inspection.
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
  const sortRaw = (url.searchParams.get("sort") ?? "").trim();
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase();
  const roleRaw = (url.searchParams.get("role") ?? "").trim();

  await connectMongo();

  const filter: Record<string, unknown> = {};
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ email: rx }, { name: rx }];
  }
  if (roleRaw) {
    // Keep this strict so "filter by role" is predictable (and avoids weird partial matches).
    const allowed = new Set(["admin", "user", "temp"]);
    if (!allowed.has(roleRaw)) {
      return NextResponse.json({ error: "role must be one of: admin | user | temp" }, { status: 400 });
    }
    filter.role = roleRaw;
  }

  const sortField = sortRaw === "lastLoginAt" ? "lastLoginAt" : "createdAt";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await UserModel.countDocuments(filter);
  const items = await UserModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      email: 1,
      name: 1,
      role: 1,
      plan: 1,
      isTemp: 1,
      isActive: 1,
      createdAt: 1,
      lastLoginAt: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
    role: roleRaw || null,
    users: items.map((u) => ({
      id: String(u._id),
      email: typeof u.email === "string" ? u.email : null,
      name: typeof u.name === "string" ? u.name : null,
      role: typeof (u as { role?: unknown }).role === "string" ? ((u as { role: string }).role as string) : null,
      plan: typeof (u as { plan?: unknown }).plan === "string" ? ((u as { plan: string }).plan as string) : "free",
      isTemp: Boolean((u as { isTemp?: unknown }).isTemp),
      isActive: (u as { isActive?: unknown }).isActive !== false,
      createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
      lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    })),
  });
}




