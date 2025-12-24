import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";

export const runtime = "nodejs";

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown;

    const rawEmail = asNonEmptyString((body as { email?: unknown }).email);
    const description = asNonEmptyString((body as { description?: unknown }).description);
    if (!rawEmail) return NextResponse.json({ error: "Missing email" }, { status: 400 });
    if (!description) return NextResponse.json({ error: "Missing description" }, { status: 400 });

    const email = normalizeEmail(rawEmail);

    await connectMongo();
    await InviteModel.create({
      kind: "request",
      requestEmail: email,
      requestDescription: description,
      isActive: true,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


