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
 * Purpose label for the derived key. Changing either of these strings rotates every ticket key, so
 * they are versioned and left alone.
 */
const TICKET_KEY_SALT = "lnkdrp-realtime-ticket";
const TICKET_KEY_INFO = "realtime-ticket-hmac:v1";

let warnedAboutDerivedKey = false;

/**
 * Derive the purpose-bound ticket key from whatever secret material was configured.
 *
 * HKDF is one-way, so a component that holds only this value cannot walk back to the input. The
 * salt and info are constants rather than per-deployment values on purpose: the Next app, the
 * standalone WebSocket server (`realtime/server.ts`) and the MCP server (`mcp/src/realtime.ts`)
 * all call this module with the same secret material and must land on the same key without
 * coordinating — and without caring which of them happens to hold which other variables.
 */
function deriveTicketKey(material: string): string {
  return Buffer.from(hkdfSync("sha256", material, TICKET_KEY_SALT, TICKET_KEY_INFO, 32)).toString("base64url");
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
 * What went wrong the second time: the first version of that fix derived only when the configured
 * secret was *recognised* as the master — `if (dedicated && dedicated !== master) return dedicated`
 * — which made the key depend on a variable that is deliberately absent from two of the three
 * hosts. An operator who sets `REALTIME_SECRET` to the same string as `NEXTAUTH_SECRET` (the very
 * case that branch was added for) gets a derived key on Vercel, where both variables are visible,
 * and the raw string on the realtime and MCP hosts, where `mcp/README.md` says never to set
 * `NEXTAUTH_SECRET`. Same configured input, two different keys, every ticket rejected with close
 * 4401 and realtime silently degraded to polling with nothing having changed in the config.
 *
 * So the key is a pure function of the configured secret material and nothing else: take
 * `REALTIME_SECRET`, or `NEXTAUTH_SECRET` when it is absent, and always run it through HKDF with
 * one fixed purpose label. Three consequences, all wanted:
 *   - the raw master secret is never the ticket key, however the operator spells the config — the
 *     equality check's whole job, now done by construction instead of by detection;
 *   - a process that holds only the ticket key can neither forge sessions nor read share passwords,
 *     even when the operator reused one string everywhere;
 *   - every process computes the same key from the same input, whatever else is in its environment,
 *     which is the property the comparison could never have on a host that cannot see both values.
 *
 * Deriving from a *dedicated* secret too costs nothing — HKDF over 32 bytes, once per call — and is
 * what makes the answer environment-independent. A distinct `REALTIME_SECRET` is still the right
 * configuration, for the reason in the warning below: it keeps `NEXTAUTH_SECRET` off those hosts.
 *
 * Deploy note: this rotates the ticket key for every deployment, including ones with a distinct
 * `REALTIME_SECRET`. Tickets live 60 seconds and the browser client falls back to polling and
 * reconnects (`src/lib/client/realtime.ts`), so a rolling deploy costs a reconnect, not an outage.
 */
export function realtimeSecret(): string {
  const dedicated = (process.env.REALTIME_SECRET || "").trim();
  const master = (process.env.NEXTAUTH_SECRET || "").trim();
  const material = dedicated || master;
  if (!material) throw new Error("Missing REALTIME_SECRET (or NEXTAUTH_SECRET) for realtime tickets");
  if (!warnedAboutDerivedKey && process.env.NODE_ENV === "production" && (!dedicated || dedicated === master)) {
    warnedAboutDerivedKey = true;
    // Once per process, and only where the problem is visible: the key derivation is safe either
    // way, but a deployment leaning on NEXTAUTH_SECRET (or reusing its value) still has to put the
    // session secret in the realtime and MCP services' own env for them to agree.
    console.warn(
      "[realtime] REALTIME_SECRET is not set (or matches NEXTAUTH_SECRET); the ticket key is derived from the session secret. Set a distinct REALTIME_SECRET so the realtime and MCP deployments need not hold NEXTAUTH_SECRET at all.",
    );
  }
  return deriveTicketKey(material);
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
