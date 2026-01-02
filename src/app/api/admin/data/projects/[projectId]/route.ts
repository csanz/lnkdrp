/**
 * Admin API route: `/api/admin/data/projects/:projectId`
 *
 * - GET: returns a single project (raw)
 * - POST: updates a project (admin tool). This is intended for manual fixes like setting `isRequest=true`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { ProjectModel } from "@/lib/models/Project";

export const runtime = "nodejs";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}
function newRequestUploadToken() {
  return randomBase62(32);
}

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const };
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

  return { ok: true as const };
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { projectId } = await params;
  if (!Types.ObjectId.isValid(projectId)) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  await connectMongo();
  const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    project: {
      id: String(project._id),
      raw: project as Record<string, unknown>,
    },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { projectId } = await params;
  if (!Types.ObjectId.isValid(projectId)) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as Partial<{
    isRequest: boolean;
    convertToRequest: boolean;
  }>;
  const convertToRequest = typeof body.convertToRequest === "boolean" ? body.convertToRequest : false;
  const isRequest = typeof body.isRequest === "boolean" ? body.isRequest : null;
  if (!convertToRequest && isRequest == null) return NextResponse.json({ error: "Missing isRequest" }, { status: 400 });

  await connectMongo();
  const p = await ProjectModel.findById(new Types.ObjectId(projectId))
    .select({ _id: 1, isRequest: 1, requestUploadToken: 1 })
    .lean();
  if (!p) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const tokenRaw = (p as { requestUploadToken?: unknown }).requestUploadToken;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";

  if (convertToRequest) {
    const nextToken = token || newRequestUploadToken();
    await ProjectModel.updateOne(
      { _id: new Types.ObjectId(projectId) },
      { $set: { isRequest: true, requestUploadToken: nextToken, autoAddFiles: false } },
    );
    return NextResponse.json({
      ok: true,
      project: { id: projectId, isRequest: true, requestUploadToken: nextToken },
    });
  }

  // Safety: only allow setting isRequest=true if a token exists (to keep model invariants intact).
  if (isRequest) {
    if (!token) {
      return NextResponse.json({ error: "Cannot set isRequest=true: missing requestUploadToken" }, { status: 400 });
    }
  }

  await ProjectModel.updateOne({ _id: new Types.ObjectId(projectId) }, { $set: { isRequest } });

  return NextResponse.json({ ok: true, project: { id: projectId, isRequest } });
}


