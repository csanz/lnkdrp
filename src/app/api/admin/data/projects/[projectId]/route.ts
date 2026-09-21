/**
 * Admin API route: `/api/admin/data/projects/:projectId`
 *
 * - GET: returns a single project row with its capability tokens removed
 * - POST: updates a project (admin tool). This is intended for manual fixes like setting `isRequest=true`.
 *
 * A Project row is three keys in a trench coat. `requestViewToken` streams the raw PDF of every
 * document in the repo through `/api/request-view/:token/docs/:docId/pdf`, which resolves the
 * project on the token alone — no session, no cookie, so the read is not even attributable to the
 * admin who made it. `requestUploadToken` plants documents in the customer's repo as if a recipient
 * had sent them. `shareId` is `/p/:shareId`, the repo itself. This route used to return the row
 * whole, and the page printed it as JSON, so all three were a select-and-copy away.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { newSecretToken } from "@/lib/crypto/randomBase62";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { stripSecrets } from "@/lib/admin/docPrivacy";

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
      raw: stripSecrets(project as Record<string, unknown>),
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
    // The minted token is not echoed back. Nothing on the page needs it — the owner gets their
    // request link from their own app — and a token in a response is a token in a log, a history
    // entry and a screenshot, for a capability that accepts uploads with no session.
    return NextResponse.json({
      ok: true,
      project: { id: projectId, isRequest: true, hasRequestUploadToken: true },
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


