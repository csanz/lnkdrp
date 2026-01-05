/**
 * Admin API route: `DELETE /api/admin/data/docs/:docId`
 *
 * Soft-deletes a doc (sets isDeleted + deletedDate).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
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

export async function DELETE(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { docId: docIdRaw } = await ctx.params;
  const docId = (docIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

  await connectMongo();
  const now = new Date();
  const res = await DocModel.updateOne(
    { _id: new Types.ObjectId(docId) },
    { $set: { isDeleted: true, deletedDate: now, isDeletedDate: now } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

  return NextResponse.json({ ok: true, docId });
}


