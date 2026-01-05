/**
 * Admin API route: `DELETE /api/admin/data/workspaces/:workspaceId`
 *
 * Soft-deletes a workspace (org) by setting `isDeleted=true`.
 *
 * NOTE: This does not cascade-delete related records.
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


