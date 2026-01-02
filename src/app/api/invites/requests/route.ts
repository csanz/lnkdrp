import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";
/**
 * Return whether localhost request.
 */


function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}
/**
 * Require Admin (uses isLocalhostRequest, resolveActor, isValid).
 */


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
/**
 * Handle GET requests.
 */


export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "pending").trim();

  await connectMongo();

  const baseQuery = { kind: "request" as const };
  const query =
    status === "sent"
      ? { ...baseQuery, approvedDate: { $ne: null }, approvalEmailSentDate: { $ne: null } }
      : status === "approved"
        ? { ...baseQuery, approvedDate: { $ne: null } }
      : status === "all"
        ? baseQuery
        : { ...baseQuery, approvedDate: null };

  const items = await InviteModel.find(query)
    .sort({ createdDate: -1 })
    .limit(200)
    .select({
      kind: 1,
      requestEmail: 1,
      requestDescription: 1,
      createdDate: 1,
      approvedDate: 1,
      approvedInviteCode: 1,
      approvalEmailSentDate: 1,
      approvalEmailError: 1,
    })
    .lean();

  return NextResponse.json({ ok: true, items });
}


