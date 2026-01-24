/**
 * Admin API route: `GET /api/admin/data/uploads`
 *
 * Lists uploads across all users (paged) for admin inspection.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { UploadModel } from "@/lib/models/Upload";
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
  const docIdRaw = (url.searchParams.get("docId") ?? "").trim();

  await connectMongo();

  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
  };

  if (docIdRaw) {
    if (!Types.ObjectId.isValid(docIdRaw)) {
      return NextResponse.json({ error: "docId must be a valid ObjectId" }, { status: 400 });
    }
    filter.docId = new Types.ObjectId(docIdRaw);
  }

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matchingDocs = await DocModel.find({ title: rx })
      .select({ _id: 1 })
      .limit(500)
      .lean();
    const docIds = matchingDocs.map((d) => d._id);
    filter.$or = [{ originalFileName: rx }, ...(docIds.length ? [{ docId: { $in: docIds } }] : [])];
  }

  const total = await UploadModel.countDocuments(filter);
  const items = await UploadModel.find(filter)
    .sort({ createdDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      userId: 1,
      docId: 1,
      version: 1,
      status: 1,
      originalFileName: 1,
      createdDate: 1,
    })
    .populate({ path: "docId", select: { title: 1, shareId: 1 } })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    uploads: items.map((u) => {
      const doc = (u.docId ?? null) as { _id?: unknown; title?: unknown; shareId?: unknown } | null;
      const docId = doc && doc._id ? String(doc._id) : u.docId ? String(u.docId) : null;
      return {
        id: String(u._id),
        userId: u.userId ? String(u.userId) : null,
        docId,
        docTitle: doc && typeof doc.title === "string" ? doc.title : null,
        shareId: doc && typeof doc.shareId === "string" ? doc.shareId : null,
        originalFileName: typeof u.originalFileName === "string" ? u.originalFileName : null,
        version: Number.isFinite(u.version) ? u.version : null,
        status: typeof u.status === "string" ? u.status : null,
        createdDate: u.createdDate ? new Date(u.createdDate).toISOString() : null,
      };
    }),
  });
}




