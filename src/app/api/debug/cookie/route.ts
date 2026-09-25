/**
 * API route for `/api/debug/cookie`.
 *
 * Dev-only helper for benchmarking: returns the incoming `Cookie` request header so a developer
 * can copy/paste it into `LNKDRP_COOKIE` when running `npm run tests:benchmark`.
 *
 * Outside production this endpoint also best-effort writes the cookie into `scripts/cookie.json`
 * (repo root) so running `npm run tests:benchmark -- --dashboard` works without extra env/flags.
 *
 * Safety:
 * - Admin only, through the same gate as `/api/admin/*` (localhost is allowed outside production).
 *   It used to accept any signed-in user outside production, which on a preview host handed a
 *   session cookie back to whoever asked for it.
 * - Production: hidden (404) unless the caller is an admin, and never touches the filesystem there.
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CookieFileResult = { ok: true; path: string } | { ok: false; error: string };

/** Best-effort write of the cookie header to `scripts/cookie.json` (dev only; never throws). */
function tryWriteCookieFile(cookie: string): CookieFileResult {
  try {
    const fp = path.join(process.cwd(), "scripts", "cookie.json");
    const next = JSON.stringify({ cookie }, null, 2) + "\n";
    fs.writeFileSync(fp, next, "utf8");
    return { ok: true, path: fp };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to write scripts/cookie.json" };
  }
}

/** Echo the caller's cookie header back (admins only). */
export async function GET(request: Request) {
  try {
    const isProd = process.env.NODE_ENV === "production";
    const gate = await requireAdmin(request);
    if (!gate.ok) {
      // Production: indistinguishable from a missing route unless the caller is an admin.
      if (isProd) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }

    const cookieHeader = request.headers.get("cookie") ?? "";
    // Filesystem writes are a local-dev convenience only (serverless filesystems are read-only anyway).
    const saved: CookieFileResult = isProd
      ? { ok: false, error: "Not written in production" }
      : cookieHeader
        ? tryWriteCookieFile(cookieHeader)
        : { ok: false, error: "Missing Cookie header" };

    return NextResponse.json(
      {
        ok: true,
        cookie: cookieHeader,
        saved,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Debug endpoint failed", context: "[api/debug/cookie] GET failed" });
  }
}
