/**
 * Realtime tickets: short-lived, HMAC-signed proof that a signed-in member may subscribe to a
 * workspace's live events. Minted by `GET /api/realtime/ticket` (Next, with the session) and
 * verified by the standalone WebSocket server (`realtime/server.ts`), which has no session
 * access and only shares the secret. Pure node:crypto so both sides can import it.
 *
 * Format: `v1.<base64url payload>.<base64url hmac-sha256>` where payload is
 * `{"u":userId,"o":orgId,"e":expiresAtUnixSeconds}`.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const REALTIME_TICKET_TTL_SECONDS = 60;

export type RealtimeTicket = { userId: string; orgId: string; expiresAt: number };

/**
 * Purpose label for the derived key. Changing either of these strings rotates every ticket key that
 * is derived rather than configured, so they are versioned and left alone.
 */
const TICKET_KEY_SALT = "lnkdrp-realtime-ticket";
const TICKET_KEY_INFO = "realtime-ticket-hmac:v1";

let warnedAboutDerivedKey = false;

/**
 * Derive a purpose-bound ticket key from a secret that is used for other things too.
 *
 * HKDF is one-way, so a component that holds only this value cannot walk back to the input. The
 * salt and info are constants rather than per-deployment values on purpose: the Next app, the
 * standalone WebSocket server (`realtime/server.ts`) and the MCP server (`mcp/src/realtime.ts`)
 * all call this module with the same env and must land on the same key without coordinating.
 */
function deriveTicketKey(master: string): string {
  return Buffer.from(hkdfSync("sha256", master, TICKET_KEY_SALT, TICKET_KEY_INFO, 32)).toString("base64url");
}

/**
 * The key these tickets are signed with.
 *
 * What went wrong: this returned `NEXTAUTH_SECRET` verbatim whenever `REALTIME_SECRET` was unset,
 * and `NEXTAUTH_SECRET` is not a realtime secret — it is the fallback behind five independent key
 * derivations in this codebase (session cookies, the AES key over every share password at rest in
 * `src/lib/sharePassword.ts`, the AES key over org invite tokens, view-notification tokens, and
 * the internal upload-processing HMAC). `realtime/server.ts` and `mcp/src/realtime.ts` are separate
 * deployments whose entire legitimate need is one 60-second HMAC key, and they were being handed
 * the value that unlocks all of that instead.
 *
 * Why the fix is shaped this way: the obvious fix — require `REALTIME_SECRET` and throw without it
 * — refuses rather than degrades. `realtime/server.ts:66` calls this at boot precisely so a
 * misconfigured deploy dies early, so throwing here would turn a single-secret production deploy
 * that works today into a crash loop. Instead the raw master secret is never used as a ticket key:
 * when it is all we have, we run it through HKDF with a fixed purpose label. Everyone importing
 * this module derives the same value, so the socket still works, and the value any of those
 * processes can leak is now a ticket key and nothing else.
 *
 * The same derivation applies when `REALTIME_SECRET` is set but is literally a copy of
 * `NEXTAUTH_SECRET` — that is the same mistake wearing a different variable name, and deriving in
 * that case keeps every deployment on the same key however each one spells the config.
 *
 * Deploy note: this rotates the ticket key for any deployment that has not set a distinct
 * `REALTIME_SECRET`. Tickets live 60 seconds and the browser client falls back to polling and
 * reconnects (`src/lib/client/realtime.ts`), so a rolling deploy costs a reconnect, not an outage.
 */
export function realtimeSecret(): string {
  const dedicated = (process.env.REALTIME_SECRET || "").trim();
  const master = (process.env.NEXTAUTH_SECRET || "").trim();
  if (dedicated && dedicated !== master) return dedicated;
  if (!master) throw new Error("Missing REALTIME_SECRET (or NEXTAUTH_SECRET) for realtime tickets");
  if (!warnedAboutDerivedKey && process.env.NODE_ENV === "production") {
    warnedAboutDerivedKey = true;
    // Once per process. Derivation keeps realtime working, but the standalone services still hold
    // NEXTAUTH_SECRET in their own env until someone sets a distinct REALTIME_SECRET.
    console.warn(
      "[realtime] REALTIME_SECRET is not set (or matches NEXTAUTH_SECRET); signing tickets with a key derived from NEXTAUTH_SECRET. Set a distinct REALTIME_SECRET so the realtime and MCP deployments need not hold the session secret.",
    );
  }
  return deriveTicketKey(master);
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
