import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";

export const runtime = "nodejs";

const INVITE_COOKIE_NAME = "ld_invite_ok";
/**
 * Normalize Code (uses toUpperCase, trim, replace).
 */


function normalizeCode(code: string) {
  // Accept common copy/paste formats (spaces/dashes) and normalize for matching.
  return code.replace(/[^a-z0-9]/gi, "").trim().toUpperCase();
}
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown;
    const rawCode = asNonEmptyString((body as { code?: unknown }).code);
    if (!rawCode) return NextResponse.json({ error: "Missing code" }, { status: 400 });

    // Support older/manual formats by trying multiple normalized variants.
    const trimmed = rawCode.trim();
    const upperTrimmed = trimmed.toUpperCase();
    const normalized = normalizeCode(rawCode);
    const candidates = Array.from(new Set([trimmed, upperTrimmed, normalized])).filter(Boolean);

    await connectMongo();
    const invite = await InviteModel.findOne({
      kind: "invite",
      code: { $in: candidates },
      isActive: { $ne: false },
    })
      .select({ _id: 1 })
      .lean();

    if (!invite) return NextResponse.json({ error: "Invalid invite code" }, { status: 401 });

    const res = NextResponse.json({ ok: true });
    res.cookies.set({
      name: INVITE_COOKIE_NAME,
      value: "1",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 14, // 14 days
    });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


