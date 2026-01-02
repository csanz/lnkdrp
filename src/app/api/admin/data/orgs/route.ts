/**
 * Admin API route: `GET /api/admin/data/orgs`
 *
 * Lists orgs (paged-ish) for admin inspection and tooling (e.g. org member viewer).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
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

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 200, 500);
  const qRaw = url.searchParams.get("q") ?? "";
  const q = qRaw.trim();

  await connectMongo();

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.name = rx;
  }

  const items = await OrgModel.find(filter)
    .sort({ createdDate: -1 })
    .limit(limit)
    .select({ type: 1, name: 1, slug: 1, personalForUserId: 1, createdDate: 1 })
    .lean();

  return NextResponse.json({
    ok: true,
    orgs: items.map((o) => ({
      id: String(o._id),
      type: typeof (o as { type?: unknown }).type === "string" ? (o as { type: string }).type : null,
      name: typeof (o as { name?: unknown }).name === "string" ? (o as { name: string }).name : null,
      slug: typeof (o as { slug?: unknown }).slug === "string" ? (o as { slug: string }).slug : null,
      personalForUserId:
        (o as { personalForUserId?: unknown }).personalForUserId instanceof Types.ObjectId
          ? String((o as { personalForUserId: Types.ObjectId }).personalForUserId)
          : null,
      createdDate: (o as { createdDate?: unknown }).createdDate instanceof Date ? o.createdDate.toISOString() : null,
    })),
  });
}



