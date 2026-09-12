import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { debugEnabled } from "@/lib/debug";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return whether the caller is a signed-in admin (same check as `src/app/api/admin/*`).
 *
 * Reads the NextAuth JWT only (no temp-user minting) and then the user's `role`.
 */
async function isAdminRequest(request: Request): Promise<boolean> {
  const session = await tryResolveAuthUserId(request);
  if (!session?.userId || !Types.ObjectId.isValid(session.userId)) return false;
  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(session.userId) }).select({ role: 1 }).lean();
  return (u as { role?: unknown } | null)?.role === "admin";
}

/**
 * Debug endpoint to confirm server-side env wiring.
 *
 * Visit `/api/debug` in the browser (or curl) and confirm:
 * - `debug.enabled` is true when `DEBUG_LEVEL=1`
 * - `env.DEBUG_LEVEL` matches what you expect
 *
 * Production: hidden (404) unless the caller is an admin, so env presence flags are never public.
 * NOTE: We intentionally do NOT return secrets, only presence flags.
 */
export async function GET(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" && !(await isAdminRequest(request))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rawDebugLevel = process.env.DEBUG_LEVEL ?? null;
    const rawPublicDebugLevel = process.env.NEXT_PUBLIC_DEBUG_LEVEL ?? null;

    return NextResponse.json(
      {
        ok: true,
        debug: {
          enabled_level1: debugEnabled(1),
          enabled_level2: debugEnabled(2),
        },
        env: {
          DEBUG_LEVEL: rawDebugLevel,
          NEXT_PUBLIC_DEBUG_LEVEL: rawPublicDebugLevel,
          NODE_ENV: process.env.NODE_ENV ?? null,
          has_MONGODB_URI: Boolean(process.env.MONGODB_URI),
          has_BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
          has_VERCEL_BLOB_CALLBACK_URL: Boolean(process.env.VERCEL_BLOB_CALLBACK_URL),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Debug endpoint failed", context: "[api/debug] GET failed" });
  }
}
