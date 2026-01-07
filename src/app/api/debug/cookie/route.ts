/**
 * API route for `/api/debug/cookie`.
 *
 * Dev-only helper for benchmarking: returns the incoming `Cookie` request header so a developer
 * can copy/paste it into `LNKDRP_COOKIE` when running `npm run tests:benchmark`.
 *
 * This endpoint also best-effort writes the cookie into `scripts/cookie.json` (repo root)
 * so running `npm run tests:benchmark -- --dashboard` works without extra env/flags.
 *
 * Safety:
 * - Requires an authenticated user (via `resolveActor`).
 * - Disabled in production unless `ALLOW_DEBUG_COOKIE=1` is explicitly set.
 */
import { NextResponse } from "next/server";
import { resolveActor } from "@/lib/gating/actor";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

function tryWriteCookieFile(cookie: string): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const fp = path.join(process.cwd(), "scripts", "cookie.json");
    const next = JSON.stringify({ cookie }, null, 2) + "\n";
    fs.writeFileSync(fp, next, "utf8");
    return { ok: true, path: fp };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to write scripts/cookie.json" };
  }
}

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const allowInProd = process.env.ALLOW_DEBUG_COOKIE === "1";
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !allowInProd) {
    return NextResponse.json({ error: "DISABLED_IN_PRODUCTION" }, { status: 403 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const saved = cookieHeader ? tryWriteCookieFile(cookieHeader) : { ok: false as const, error: "Missing Cookie header" };
  return NextResponse.json({
    ok: true,
    cookie: cookieHeader,
    saved,
  });
}


