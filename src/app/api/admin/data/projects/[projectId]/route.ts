/**
 * Admin API route: `/api/admin/data/projects/:projectId`
 *
 * - GET: returns a single project (raw)
 * - POST: updates a project (admin tool). This is intended for manual fixes like setting `isRequest=true`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { newSecretToken } from "@/lib/crypto/randomBase62";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";

/**
 *
 */
function newRequestUploadToken() {
  return newSecretToken(32);
}



/**
 *
 */
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

/**
 *
 */
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

/**
 *
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { projectId } = await params;
  if (!Types.ObjectId.isValid(projectId)) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  await connectMongo();
  const res = await ProjectModel.updateOne({ _id: new Types.ObjectId(projectId) }, { $set: { isDeleted: true } });
  if (!res.matchedCount) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  return NextResponse.json({ ok: true, projectId });
}


