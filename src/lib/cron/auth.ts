/**
 * Shared cron route authentication.
 *
 * Vercel Cron invokes cron routes with `Authorization: Bearer $CRON_SECRET`.
 * We also accept the legacy `x-cron-secret` header and a `?secret=` query param
 * for manual/dev invocations.
 *
 * Secret sources (first non-empty wins): `CRON_SECRET` (preferred), `LNKDRP_CRON_SECRET`.
 *
 * Fail-closed: when no secret is configured, requests are only allowed in
 * non-production environments (`VERCEL_ENV !== "production"` and `NODE_ENV !== "production"`).
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { debugWarn } from "@/lib/debug";

/** Resolve the configured cron secret (trimmed), or null when unset. */
function configuredCronSecret(): string | null {
  const primary = (process.env.CRON_SECRET ?? "").trim();
  if (primary) return primary;
  const legacy = (process.env.LNKDRP_CRON_SECRET ?? "").trim();
  return legacy || null;
}

/** Whether this process is running as a production deployment. */
function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

/** Constant-time string comparison; returns false on length mismatch without leaking timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract the caller-provided secret from headers or query (first present wins). */
function providedCronSecret(request: Request): string | null {
  const auth = (request.headers.get("authorization") ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && bearer[1]?.trim()) return bearer[1].trim();

  const legacyHeader = (request.headers.get("x-cron-secret") ?? "").trim();
  if (legacyHeader) return legacyHeader;

  try {
    const q = (new URL(request.url).searchParams.get("secret") ?? "").trim();
    if (q) return q;
  } catch {
    // ignore malformed URL
  }
  return null;
}

/**
 * Authorize a cron request.
 *
 * Returns `null` when the request is authorized, otherwise a 401 JSON response.
 * When no secret is configured, non-production environments are allowed through
 * and production is rejected (fail closed).
 */
export function requireCronAuth(request: Request): Response | null {
  const secret = configuredCronSecret();

  if (!secret) {
    if (isProductionEnv()) {
      debugWarn(1, "[cron-auth] rejected: no CRON_SECRET/LNKDRP_CRON_SECRET configured in production");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  }

  const provided = providedCronSecret(request);
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
