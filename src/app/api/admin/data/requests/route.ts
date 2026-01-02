/**
 * Admin API route: `GET /api/admin/data/requests`
 *
 * Lists request link repos (stored as Projects with request fields) across all users (paged).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { ProjectModel } from "@/lib/models/Project";

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

  // Backfill: ensure `isRequest=true` is persisted for any repo that already has a token.
  // Admin views should reflect the canonical discriminator to avoid confusion.
  await ProjectModel.updateMany(
    {
      requestUploadToken: { $exists: true, $nin: [null, ""] },
      $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }],
    },
    { $set: { isRequest: true } },
  );

  // Request repos are stored as Projects with request-only fields (e.g. requestUploadToken).
  const filter: Record<string, unknown> = {
    $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $ne: null } }],
  };

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [
      filter,
      {
        $or: [{ name: rx }, { slug: rx }, { shareId: rx }, { requestUploadToken: rx }],
      },
    ];
    delete filter.$or;
  }

  const total = await ProjectModel.countDocuments(filter);
  const items = await ProjectModel.find(filter)
    .sort({ updatedDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      userId: 1,
      name: 1,
      slug: 1,
      description: 1,
      shareId: 1,
      docCount: 1,
      createdDate: 1,
      updatedDate: 1,
      // request-only fields (not necessarily in schema; ok for Mongo select)
      isRequest: 1,
      requestUploadToken: 1,
      requestReviewEnabled: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    requests: items.map((p) => ({
      id: String(p._id),
      userId: p.userId ? String(p.userId) : null,
      name: typeof p.name === "string" ? p.name : null,
      slug: typeof p.slug === "string" ? p.slug : null,
      description: typeof p.description === "string" ? p.description : null,
      shareId: typeof p.shareId === "string" ? p.shareId : null,
      docCount: Number.isFinite(p.docCount) ? p.docCount : null,
      isRequest: Boolean((p as { isRequest?: unknown }).isRequest),
      requestUploadToken:
        typeof (p as { requestUploadToken?: unknown }).requestUploadToken === "string"
          ? (p as unknown as { requestUploadToken: string }).requestUploadToken
          : null,
      requestReviewEnabled: Boolean((p as { requestReviewEnabled?: unknown }).requestReviewEnabled),
      updatedDate: (p as unknown as { updatedDate?: Date | string | null }).updatedDate
        ? new Date((p as unknown as { updatedDate: Date | string }).updatedDate).toISOString()
        : null,
      createdDate: (p as unknown as { createdDate?: Date | string | null }).createdDate
        ? new Date((p as unknown as { createdDate: Date | string }).createdDate).toISOString()
        : null,
    })),
  });
}


