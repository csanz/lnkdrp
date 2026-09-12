/**
 * Uniform JSON error responses for API routes.
 *
 * Raw error messages (Mongo `E11000 dup key { shareId: ... }`, connection strings in stack
 * traces, etc.) must never reach clients in production. This helper logs the real error server-side
 * and returns a stable, generic message; outside production it also attaches the raw message as
 * `detail` so local debugging stays convenient.
 */
import { NextResponse } from "next/server";
import { debugError } from "@/lib/debug";

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
 * Log `err` and return a `NextResponse.json({ error: publicMessage })`.
 *
 * In non-production environments the response also carries `detail` with the raw message.
 */
export function errorJson(err: unknown, opts: ErrorJsonOptions): NextResponse {
  const message = errorMessage(err);
  debugError(1, opts.context ?? "[api] request failed", { status: opts.status, message, ...(opts.logMeta ?? {}) });

  const body: { error: string; detail?: string } = { error: opts.publicMessage };
  if (process.env.NODE_ENV !== "production") body.detail = message;

  return NextResponse.json(body, { status: opts.status, headers: { "cache-control": "no-store" } });
}
