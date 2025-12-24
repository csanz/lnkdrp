import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";
import { UserModel } from "@/lib/models/User";
import crypto from "node:crypto";

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

function generateInviteCode() {
  // 5 chars, A-Z and 0-9, all caps (easy to read/type).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(5);
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "active").trim();

  await connectMongo();

  const baseQuery = { kind: "invite" as const };
  const query =
    status === "inactive"
      ? { ...baseQuery, isActive: false }
      : status === "all"
        ? baseQuery
        : { ...baseQuery, isActive: { $ne: false } };

  const items = await InviteModel.find(query)
    .sort({ createdDate: -1 })
    .limit(500)
    .select({ code: 1, isActive: 1, createdDate: 1 })
    .lean();

  return NextResponse.json({ ok: true, items });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await connectMongo();

  let inviteCode: string | null = null;
  let inviteId: string | null = null;

  for (let i = 0; i < 6; i++) {
    const code = generateInviteCode();
    try {
      const created = await InviteModel.create({ kind: "invite", code, isActive: true });
      inviteCode = code;
      inviteId = String(created._id);
      break;
    } catch {
      // retry on dup
    }
  }

  if (!inviteCode || !inviteId) {
    return NextResponse.json({ error: "Failed to generate invite code" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inviteId, inviteCode });
}


