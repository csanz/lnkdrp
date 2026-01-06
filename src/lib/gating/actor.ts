import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel, createTempUser, verifyTempUserSecret } from "@/lib/models/User";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { TEMP_USER_ID_HEADER, TEMP_USER_SECRET_HEADER } from "@/lib/gating/tempUserHeaders";
import { ACTIVE_ORG_COOKIE } from "@/app/api/orgs/active/route";

const ACTOR_CACHE = new WeakMap<Request, Promise<Actor>>();

/**
 * Server-side "actor" resolution for API routes.
 *
 * Many routes can be accessed by:
 * - a signed-in user (NextAuth), or
 * - a "temp user" identified by headers (used for share/request flows).
 *
 * This module resolves the effective actor for an incoming `Request` and
 * optionally mints temp-user headers when a new temp user is created.
 */
// Re-export header names for backwards compatibility with existing imports.
export { TEMP_USER_ID_HEADER, TEMP_USER_SECRET_HEADER };

/** The authenticated identity making an API request. */
export type Actor =
  | { kind: "user"; userId: string; orgId: string; personalOrgId: string }
  | {
      kind: "temp";
      userId: string;
      orgId: string;
      personalOrgId: string;
      temp: { id: string; secret?: string };
      isNew: boolean;
    };

/** Return whether NextAuth is configured (i.e. auth can be enabled). */
function isAuthConfigured(): boolean {
  // Mirrors the client-side `enableAuth` guard in `src/app/layout.tsx`.
  return (
    Boolean(process.env.MONGODB_URI) &&
    Boolean(process.env.NEXTAUTH_SECRET) &&
    Boolean(process.env.GOOGLE_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_CLIENT_SECRET)
  );
}

/**
 * Try to resolve the signed-in user id from the incoming request cookies.
 *
 * We read the NextAuth JWT via `next-auth/jwt#getToken` because, in route handlers,
 * `getServerSession()` can be unreliable across Next/NextAuth versions.
 */
async function tryGetSessionClaims(
  request: Request,
): Promise<{ userId: string; activeOrgId: string | null } | null> {
  if (!isAuthConfigured()) return null;
  try {
    /**
     * In Next.js route handlers, `getServerSession()` can be unreliable across versions
     * because it depends on framework request context wiring.
     *
     * Reading the NextAuth JWT directly from the incoming Request cookies is
     * deterministic and works for both API routes and background tasks that still
     * have access to the original Request.
     */
    const { getToken } = await import("next-auth/jwt");
    const token = await getToken({
      // `getToken` supports both NextRequest and NextApiRequest shapes. Our route
      // handlers use the Web `Request` type; it includes `headers` with `cookie`.
      req: request as unknown as Parameters<typeof getToken>[0]["req"],
      secret: process.env.NEXTAUTH_SECRET,
    });
    const t = token as unknown as {
      userId?: unknown;
      sub?: unknown;
      activeOrgId?: unknown;
    } | null;
    const id = t?.userId;
    const fallbackSub = t?.sub;
    const resolvedUserId =
      typeof id === "string" && id ? id : typeof fallbackSub === "string" && fallbackSub ? fallbackSub : null;
    if (!resolvedUserId) return null;
    const activeOrgId = typeof t?.activeOrgId === "string" && t.activeOrgId.trim() ? t.activeOrgId.trim() : null;
    return { userId: resolvedUserId, activeOrgId };
  } catch {
    return null;
  }
}

/**
 * Fast path: resolve authenticated user id (and JWT activeOrgId claim) without any DB access.
 *
 * Use this for auth-required endpoints that already validate permissions via their own
 * org-scoped membership checks and don't need the full "active org" resolution logic.
 */
export async function tryResolveAuthUserId(request: Request): Promise<{ userId: string; activeOrgId: string | null } | null> {
  return await tryGetSessionClaims(request);
}

/** Read a request header, tolerating different casing. */
function header(request: Request, name: string): string | null {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

function readCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

/**
 * If `actor` is a newly-created temp user, attach temp-user headers to the response.
 * This lets the browser persist the temp identity for subsequent calls.
 */
export function applyTempUserHeaders(
  res: Response,
  actor: Actor,
): Response {
  if (actor.kind !== "temp") return res;
  if (!actor.isNew) return res;
  if (!actor.temp.secret) return res;
  res.headers.set(TEMP_USER_ID_HEADER, actor.temp.id);
  res.headers.set(TEMP_USER_SECRET_HEADER, actor.temp.secret);
  return res;
}

/**
 * Best-effort resolve a signed-in "user" actor from the incoming request cookies.
 *
 * Unlike `resolveActor()`, this does **not** validate temp-user headers and does **not**
 * create/mint a new temp user when no authenticated session exists.
 */
export async function tryResolveUserActor(request: Request): Promise<Actor | null> {
  const session = await tryGetSessionClaims(request);
  if (!session?.userId) return null;

  await connectMongo();
  const fallbackOrg = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(session.userId) });
  const personalOrgId = String(fallbackOrg.orgId);
  // Source of truth priority:
  // 1) UserModel.metadata.activeOrgId (server-persisted, avoids cookie edge cases)
  // 2) active-org cookie (membership validated)
  // 3) JWT claim
  // 4) personal org
  let orgId = session.activeOrgId ?? personalOrgId;

  try {
    const u = await UserModel.findOne({ _id: new Types.ObjectId(session.userId) })
      .select({ metadata: 1 })
      .lean();
    const raw =
      u && typeof (u as { metadata?: unknown }).metadata === "object" ? (u as { metadata?: any }).metadata : null;
    const dbOrgId = raw && typeof raw.activeOrgId === "string" ? String(raw.activeOrgId).trim() : "";
    if (dbOrgId && Types.ObjectId.isValid(dbOrgId)) {
      const ok = await OrgMembershipModel.exists({
        orgId: new Types.ObjectId(dbOrgId),
        userId: new Types.ObjectId(session.userId),
        isDeleted: { $ne: true },
      });
      if (ok) orgId = dbOrgId;
    }
  } catch {
    // ignore; best-effort
  }

  try {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const raw = readCookie(cookieHeader, ACTIVE_ORG_COOKIE);
    const cookieOrgId = typeof raw === "string" ? raw.trim() : "";
    if (cookieOrgId && Types.ObjectId.isValid(cookieOrgId)) {
      const ok = await OrgMembershipModel.exists({
        orgId: new Types.ObjectId(cookieOrgId),
        userId: new Types.ObjectId(session.userId),
        isDeleted: { $ne: true },
      });
      if (ok) orgId = cookieOrgId;
    }
  } catch {
    // ignore; fall back to session claim/personal org
  }

  return { kind: "user", userId: session.userId, orgId, personalOrgId };
}

/**
 * Resolve the current "actor" for an API request:
 * - signed-in user (NextAuth session), else
 * - temp user (by headers), else
 * - create a new temp user.
 */
export async function resolveActor(request: Request): Promise<Actor> {
  const cached = ACTOR_CACHE.get(request);
  if (cached) return await cached;
  const p = (async () => {
  // 1) Authenticated user (preferred)
  const userActor = await tryResolveUserActor(request);
  if (userActor) return userActor;

  // Dev/test-only bypass for route testing:
  // Only applies when there is NO authenticated session user.
  // This is intentionally blocked in production environments.
  const bypass =
    (process.env.API_TEST_BYPASS_AUTH ?? "").trim().toLowerCase() === "1" ||
    (process.env.API_TEST_BYPASS_AUTH ?? "").trim().toLowerCase() === "true";
  const testUserId = (process.env.API_TEST_USER_ID ?? "").trim();
  if (bypass && process.env.NODE_ENV !== "production" && testUserId && Types.ObjectId.isValid(testUserId)) {
    await connectMongo();
    const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(testUserId) });
    const personalOrgId = String(orgId);
    return { kind: "user", userId: testUserId, orgId: personalOrgId, personalOrgId };
  }

  // 2) Temp user via headers
  const tempId = header(request, TEMP_USER_ID_HEADER);
  const tempSecret = header(request, TEMP_USER_SECRET_HEADER);
  if (tempId && tempSecret && Types.ObjectId.isValid(tempId)) {
    await connectMongo();
    const u = await UserModel.findOne({ _id: new Types.ObjectId(tempId), isTemp: true })
      .select({ _id: 1, tempSecretHash: 1 })
      .lean();

    if (u && verifyTempUserSecret({ secret: tempSecret, secretHash: u.tempSecretHash ?? null })) {
      const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(String(u._id)) });
      const personalOrgId = String(orgId);
      return {
        kind: "temp",
        userId: String(u._id),
        orgId: personalOrgId,
        personalOrgId,
        temp: { id: String(u._id) },
        isNew: false,
      };
    }
  }

  // 3) Create a new temp user
  await connectMongo();
  const created = await createTempUser();
  const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(created.id) });
  const personalOrgId = String(orgId);
  return {
    kind: "temp",
    userId: created.id,
    orgId: personalOrgId,
    personalOrgId,
    temp: { id: created.id, secret: created.secret },
    isNew: true,
  };
  })();
  ACTOR_CACHE.set(request, p);
  return await p;
}

/**
 * Faster actor resolution for stats/analytics endpoints.
 *
 * Goal: avoid repeated DB work on hot read paths. This prefers already-server-issued org context:
 * - active-org cookie (set only after membership validation)
 * - NextAuth JWT claim `activeOrgId`
 *
 * Falls back to full `resolveActor()` when we can't safely determine org context.
 */
export async function resolveActorForStats(request: Request): Promise<Actor> {
  const cached = ACTOR_CACHE.get(request);
  if (cached) return await cached;

  const p = (async () => {
    const session = await tryGetSessionClaims(request);
    if (!session?.userId) return await resolveActor(request);

    const cookieHeader = request.headers.get("cookie") ?? "";
    const cookieOrgIdRaw = readCookie(cookieHeader, ACTIVE_ORG_COOKIE);
    const cookieOrgId = typeof cookieOrgIdRaw === "string" ? cookieOrgIdRaw.trim() : "";
    const claimOrgId = typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "";

    // Prefer server-issued active-org cookie when present; otherwise fall back to JWT claim.
    const orgId = cookieOrgId && Types.ObjectId.isValid(cookieOrgId) ? cookieOrgId : claimOrgId;
    if (!orgId || !Types.ObjectId.isValid(orgId)) {
      // If org context is missing, fall back to the full resolver (ensures personal org exists).
      return await resolveActor(request);
    }

    // Security: membership can change after a cookie is minted. Validate membership once (1 query).
    // (We intentionally avoid the heavier `tryResolveUserActor` flow that also ensures personal org.)
    await connectMongo();
    const ok = await OrgMembershipModel.exists({
      orgId: new Types.ObjectId(orgId),
      userId: new Types.ObjectId(session.userId),
      isDeleted: { $ne: true },
    });
    if (!ok) return await resolveActor(request);

    // For stats endpoints we don't need personalOrgId for legacy access checks.
    // Keep it stable without extra DB reads.
    return { kind: "user", userId: session.userId, orgId, personalOrgId: orgId };
  })();

  ACTOR_CACHE.set(request, p);
  return await p;
}




