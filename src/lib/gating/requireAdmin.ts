/**
 * The admin gate for `/api/admin/*`, in one place.
 *
 * It lived in twenty-six copies — one per route file, in four slightly different versions that had
 * already drifted on their localhost bypass and on what they returned. A security check that exists
 * twenty-six times is a security check that will be fixed twenty-five times.
 *
 * Two rules:
 *
 * 1. **The actor must be a signed-in user whose account role is `admin`.**
 * 2. **The actor must not have come from an API key.** This is the rule the copies were missing.
 *    A key resolves to the member who created it (`Actor.viaApiKey`), which is what makes agent
 *    actions attributable — but it also means a key silently carries everything its owner can do.
 *    An admin who connects an agent to share a PDF was handing that agent every user's data, the
 *    error log, billing and cron health, none of which any key scope mentions. Keys are scoped
 *    `read` / `write` for documents and links; "be an administrator" is not a scope and cannot be
 *    requested, so it must not be inherited.
 *
 * The localhost bypass is development-only and exists so the admin screens work against a local
 * server without a seeded admin account. It is off in production regardless of headers, and can be
 * turned off in development with `ADMIN_LOCALHOST_BYPASS=0`.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveExistingActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";

export type AdminGate =
  | { ok: true; userId: string | null; email: string | null }
  | { ok: false; status: number; error: string };

/**
 * Development-only convenience. Never true in production, whatever the `Host` header says.
 *
 * Two environment checks, not one, and the rest of the codebase already does both - see
 * `src/lib/cron/auth.ts` and `src/lib/errors/logger.ts`. What this gate opens is everything: a
 * `Host: localhost:3001` header makes the caller a full admin across `/api/admin/*` and `/a`,
 * able to read every workspace, change credits and delete accounts. Vercel does set `NODE_ENV`, so
 * one check covers the planned topology - and stops covering it the moment anything serves this
 * app another way: a staging host started with a bare `node server.js`, a container that forgets
 * the variable, the `realtime:prod` and `mcp:prod` scripts which set no `NODE_ENV` at all. One
 * missing variable should not be the whole distance between the gate and no gate.
 */
function isLocalhostBypassAllowed(request: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if ((process.env.VERCEL_ENV ?? "").trim() === "production") return false;
  if ((process.env.ADMIN_LOCALHOST_BYPASS ?? "").trim() === "0") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

export async function requireAdmin(request: Request): Promise<AdminGate> {
  if (isLocalhostBypassAllowed(request)) return { ok: true, userId: null, email: null };

  // `resolveExistingActor`, never `resolveActor`: the latter *mints*. One anonymous GET to an admin
  // endpoint created a temp user, a personal org and a membership, and then returned 401 — so an
  // unauthenticated caller could fill the database from a door they were never let through. This
  // returns null for a caller with no identity, which lands on the same 401 without writing anything.
  const actor = await resolveExistingActor(request);
  if (!actor || actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  // Before the role lookup on purpose: an API key must be refused whether or not its owner happens
  // to be an admin, and the reply must not differ between those two cases.
  if (actor.viaApiKey) {
    return { ok: false, status: 403, error: "API keys cannot access admin endpoints" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1, email: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false, status: 403, error: "Forbidden" };

  const emailRaw = (u as { email?: unknown } | null)?.email;
  return { ok: true, userId: actor.userId, email: typeof emailRaw === "string" ? emailRaw : null };
}
