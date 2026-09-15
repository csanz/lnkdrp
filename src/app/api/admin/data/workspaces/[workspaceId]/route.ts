/**
 * Admin API route: `DELETE /api/admin/data/workspaces/:workspaceId`
 *
 * Soft-deletes a workspace (org) by setting `isDeleted=true`.
 *
 * NOTE: This does not cascade-delete related records.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { workspaceId: workspaceIdRaw } = await ctx.params;
  const workspaceId = (workspaceIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(workspaceId)) return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });

  await connectMongo();
  const res = await OrgModel.updateOne({ _id: new Types.ObjectId(workspaceId) }, { $set: { isDeleted: true } });
  if (!res.matchedCount) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  return NextResponse.json({ ok: true, workspaceId });
}


