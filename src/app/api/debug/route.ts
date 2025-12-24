import { NextResponse } from "next/server";
import { debugEnabled } from "@/lib/debug";

export const runtime = "nodejs";

/**
 * Debug endpoint to confirm server-side env wiring.
 *
 * Visit `/api/debug` in the browser (or curl) and confirm:
 * - `debug.enabled` is true when `DEBUG_LEVEL=1`
 * - `env.DEBUG_LEVEL` matches what you expect
 *
 * NOTE: We intentionally do NOT return secrets, only presence flags.
 */
export async function GET() {
  const rawDebugLevel = process.env.DEBUG_LEVEL ?? null;
  const rawPublicDebugLevel = process.env.NEXT_PUBLIC_DEBUG_LEVEL ?? null;

  return NextResponse.json({
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
  });
}




