/**
 * Realtime tickets: short-lived, HMAC-signed proof that a signed-in member may subscribe to a
 * workspace's live events. Minted by `GET /api/realtime/ticket` (Next, with the session) and
 * verified by the standalone WebSocket server (`realtime/server.ts`), which has no session
 * access and only shares the secret. Pure node:crypto so both sides can import it.
 *
 * Format: `v1.<base64url payload>.<base64url hmac-sha256>` where payload is
 * `{"u":userId,"o":orgId,"e":expiresAtUnixSeconds}`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const REALTIME_TICKET_TTL_SECONDS = 60;

export type RealtimeTicket = { userId: string; orgId: string; expiresAt: number };

/** Shared secret: `REALTIME_SECRET`, else `NEXTAUTH_SECRET` so a single-secret deploy still works. */
export function realtimeSecret(): string {
  const s = (process.env.REALTIME_SECRET || process.env.NEXTAUTH_SECRET || "").trim();
  if (!s) throw new Error("Missing REALTIME_SECRET (or NEXTAUTH_SECRET) for realtime tickets");
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Mint a ticket for `userId` on `orgId`, valid for `ttlSeconds` (default 60s). */
export function signRealtimeTicket(
  input: { userId: string; orgId: string },
  opts: { ttlSeconds?: number; now?: number; secret?: string } = {},
): { ticket: string; expiresAt: number } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + (opts.ttlSeconds ?? REALTIME_TICKET_TTL_SECONDS);
  const payload = b64url(JSON.stringify({ u: input.userId, o: input.orgId, e: expiresAt }));
  const sig = sign(payload, opts.secret ?? realtimeSecret());
  return { ticket: `v1.${payload}.${sig}`, expiresAt };
}

/** Verify a ticket; `null` when malformed, tampered with, or expired. */
export function verifyRealtimeTicket(ticket: string | null | undefined, opts: { now?: number; secret?: string } = {}): RealtimeTicket | null {
  if (!ticket || typeof ticket !== "string") return null;
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const expected = sign(payload, opts.secret ?? realtimeSecret());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: { u?: unknown; o?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const userId = typeof parsed.u === "string" ? parsed.u : "";
  const orgId = typeof parsed.o === "string" ? parsed.o : "";
  const expiresAt = typeof parsed.e === "number" ? parsed.e : 0;
  if (!userId || !orgId || !expiresAt) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (expiresAt <= now) return null;
  return { userId, orgId, expiresAt };
}
