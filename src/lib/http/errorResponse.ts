/**
 * Uniform JSON error responses for API routes.
 *
 * Raw error messages (Mongo `E11000 dup key { shareId: ... }`, connection strings in stack
 * traces, etc.) must never reach clients in production. This helper logs the real error server-side
 * and returns a stable, generic message; outside production it also attaches the raw message as
 * `detail` so local debugging stays convenient.
 */
import { NextResponse } from "next/server";
import { ApiKeyAuthError } from "@/lib/gating/apiKeyActor";
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";
import { debugEnabled } from "@/lib/debug";
import { ERROR_CODE_UNHANDLED_EXCEPTION, logErrorEvent, redactLogText, sanitizeMeta } from "@/lib/errors/logger";

export type ErrorJsonOptions = {
  /** HTTP status for the response. */
  status: number;
  /** Message safe to show to any caller. */
  publicMessage: string;
  /** Optional log prefix, e.g. `[api/docs] GET failed`. */
  context?: string;
  /** Optional extra fields for the server-side log only (never sent to the client). */
  logMeta?: Record<string, unknown>;
};

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * The response for a failure that is the caller's authentication or rate limit, or null.
 *
 * For routes that keep their own catch-all message: without this, a revoked key or a key over its
 * ceiling came back as a 400 carrying the raw message, which clients cannot tell from bad input.
 */
export function authOrRateLimitResponse(err: unknown): NextResponse | null {
  const limited = actorRateLimitResponse(err);
  if (limited) return limited;
  if (err instanceof ApiKeyAuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  return null;
}

/**
 * Log `err` and return a `NextResponse.json({ error: publicMessage })`.
 *
 * In non-production environments the response also carries `detail` with the raw message.
 */
export function errorJson(err: unknown, opts: ErrorJsonOptions): NextResponse {
  // Over a temp-workspace or API-key ceiling: a 429 with `Retry-After`, not a 500.
  const limited = actorRateLimitResponse(err);
  if (limited) return limited;
  // A bad or read-only API key is a client error with its own status, not a 500.
  if (err instanceof ApiKeyAuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  const message = errorMessage(err);
  const context = opts.context ?? "[api] request failed";

  // Always one redacted line, whatever DEBUG_LEVEL is: DEBUG_LEVEL must stay unset in production,
  // and without this a caught 500 left nothing in Vercel Logs. No stack, body or logMeta unless debugging.
  // eslint-disable-next-line no-console
  console.error(context, {
    status: opts.status,
    name: err instanceof Error ? err.name : typeof err,
    message: redactLogText(message),
    ...(debugEnabled(1) && opts.logMeta ? { meta: sanitizeMeta(opts.logMeta) } : {}),
  });
  // Every response this helper builds is an unhandled exception (`code` below says so), so every
  // one is an ErrorEvent, whatever status the route chose. This used to be gated on `>= 500`, and
  // a dozen catch-alls answered 400 for a thrown error (a Mongo outage read as "bad request"), so
  // an infrastructure failure on the sidebar, docs list, share ingest or unlock left nothing in
  // `/a` at all (code review 2026-09-23, M18). Those routes answer 500 now, and the gate is gone.
  {
    // No-ops unless ERROR_LOGGING_ENABLED=true; never throws.
    void logErrorEvent({
      severity: "error",
      category: "api",
      code: ERROR_CODE_UNHANDLED_EXCEPTION,
      err,
      route: context,
      statusCode: opts.status,
      meta: opts.logMeta,
    }).catch(() => {});
  }

  /**
   * `code` so a machine can tell "we broke" from "you asked wrong", after the text is redacted.
   *
   * `error` is a public sentence and `detail` only exists outside production, so in production the
   * one signal that this was an unhandled fault disappeared entirely — and the MCP, which infers
   * the difference from the text, classified these as the caller's mistake and told agents to fix
   * their arguments. There are no arguments that fix a caught exception, so they retried forever.
   * This field survives redaction and says which kind it is.
   */
  const body: { error: string; code: string; detail?: string } = {
    error: opts.publicMessage,
    code: ERROR_CODE_UNHANDLED_EXCEPTION,
  };
  if (process.env.NODE_ENV !== "production") body.detail = message;

  return NextResponse.json(body, { status: opts.status, headers: { "cache-control": "no-store" } });
}
