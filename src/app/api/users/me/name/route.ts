/**
 * API route for `/api/users/me/name` — update the signed-in user's display name.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function asTrimmedString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  return s;
}

function buildFullName(firstName: string, lastName: string | null): string {
  const first = firstName.trim();
  const last = (lastName ?? "").trim();
  return last ? `${first} ${last}` : first;
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Invalid actor" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as unknown as {
      firstName?: unknown;
      lastName?: unknown;
    };

    const firstName = asTrimmedString(body.firstName, 60);
    const lastNameRaw = body.lastName;
    const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";

    if (!firstName) {
      return NextResponse.json({ error: "Missing firstName" }, { status: 400 });
    }
    if (lastName.length > 60) {
      return NextResponse.json({ error: "Invalid lastName" }, { status: 400 });
    }

    const name = buildFullName(firstName, lastName || null);
    if (name.length > 120) {
      return NextResponse.json({ error: "Name too long" }, { status: 400 });
    }

    await connectMongo();
    await UserModel.updateOne({ _id: new Types.ObjectId(actor.userId) }, { $set: { name } });

    return NextResponse.json({ ok: true, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


