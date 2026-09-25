import { NextResponse } from "next/server";
import { debugEnabled } from "@/lib/debug";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Debug endpoint to confirm server-side env wiring.
 *
 * Visit `/api/debug` in the browser (or curl) and confirm:
 * - `debug.enabled` is true when `DEBUG_LEVEL=1`
 * - `env.DEBUG_LEVEL` matches what you expect
 *
 * Admin only, through the same gate as `/api/admin/*` (which allows localhost outside production),
 * rather than a `NODE_ENV` check of its own: a preview or staging host that is not "production"
 * used to answer anyone. In production a non-admin gets 404, so the route does not exist for them.
 * NOTE: We intentionally do NOT return secrets, only presence flags.
 */
export async function GET(request: Request) {
  try {
    const gate = await requireAdmin(request);
    if (!gate.ok) {
      if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: gate.error }, { status: gate.status });
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
