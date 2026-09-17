/**
 * Shared cron route authentication.
 *
 * Vercel Cron invokes cron routes with `Authorization: Bearer $CRON_SECRET`.
 * We also accept the legacy `x-cron-secret` header, and outside production a
 * `?secret=` query param for dev convenience. Production ignores the query form:
 * a secret in a URL lands in request logs, log drains and monitor configs.
 *
 * Secret sources (first non-empty wins): `CRON_SECRET` (preferred), `LNKDRP_CRON_SECRET`.
 *
 * `requireCronMonitorAuth` guards the read-only `/api/monitor/crons`. It also takes
 * `CRON_MONITOR_SECRET`, which never authorizes running a job, so an uptime monitor
 * vendor does not have to hold a secret that can trigger billing or email crons.
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

/** Resolve the read-only monitor secret (trimmed), or null when unset. */
function configuredMonitorSecret(): string | null {
  return (process.env.CRON_MONITOR_SECRET ?? "").trim() || null;
}

/** Extract the caller-provided secret from headers, or the query outside production (first present wins). */
function providedCronSecret(request: Request): string | null {
  const auth = (request.headers.get("authorization") ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && bearer[1]?.trim()) return bearer[1].trim();

  const legacyHeader = (request.headers.get("x-cron-secret") ?? "").trim();
  if (legacyHeader) return legacyHeader;

  if (isProductionEnv()) return null;
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
  return authorize(request, [configuredCronSecret()], "CRON_SECRET/LNKDRP_CRON_SECRET");
}

/**
 * Authorize a read of cron health (`/api/monitor/crons`).
 *
 * Accepts `CRON_MONITOR_SECRET` or the cron secret, so setting the monitor secret does not
 * break a monitor still sending `CRON_SECRET`. With neither configured it behaves like
 * {@link requireCronAuth}: open outside production, 401 in production.
 */
export function requireCronMonitorAuth(request: Request): Response | null {
  return authorize(
    request,
    [configuredMonitorSecret(), configuredCronSecret()],
    "CRON_MONITOR_SECRET/CRON_SECRET/LNKDRP_CRON_SECRET",
  );
}

/** Shared check: authorized when the provided secret matches any configured one. */
function authorize(request: Request, candidates: (string | null)[], names: string): Response | null {
  const secrets = candidates.filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    if (isProductionEnv()) {
      debugWarn(1, `[cron-auth] rejected: no ${names} configured in production`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  }

  const provided = providedCronSecret(request);
  // Compare against every candidate (no early exit) so timing does not reveal which one matched.
  let ok = false;
  if (provided) for (const secret of secrets) ok = safeEqual(provided, secret) || ok;
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
