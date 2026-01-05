import crypto from "node:crypto";

/**
 * Generate a safe idempotency key for user-initiated requests.
 *
 * Prefer sending an explicit `x-idempotency-key` header from the client. This helper
 * exists for server-side call sites (e.g. background jobs) and as a last-resort fallback.
 */
export function generateIdempotencyKey(prefix: string): string {
  const p = (prefix ?? "").trim().replace(/\s+/g, "-").slice(0, 32) || "run";
  // crypto.randomUUID is available on modern Node, but keep a fallback for safety.
  const id =
    typeof (crypto as any).randomUUID === "function"
      ? (crypto as any).randomUUID()
      : crypto.randomBytes(16).toString("hex");
  return `${p}:${id}`;
}

export function idempotencyKeyFromRequest(request: Request): string | null {
  const raw = request.headers.get("x-idempotency-key") ?? request.headers.get("x-idempotencykey");
  const v = (raw ?? "").trim();
  return v ? v : null;
}


