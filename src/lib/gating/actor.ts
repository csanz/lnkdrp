import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel, createTempUser, verifyTempUserSecret } from "@/lib/models/User";
import { ensurePersonalOrgForUserId, OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { TEMP_USER_ID_HEADER, TEMP_USER_SECRET_HEADER } from "@/lib/gating/tempUserHeaders";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { tryResolveApiKeyActor } from "@/lib/gating/apiKeyActor";
import { guardTempWorkspaceCreation } from "@/lib/gating/actorRateLimit";

const ACTOR_CACHE = new WeakMap<Request, Promise<Actor>>();

/**
 * Short-lived in-memory membership cache.
 *
 * Why: the dashboard can fire multiple API requests in quick succession; doing the same
 * `OrgMembership.exists({ orgId, userId })` round-trip repeatedly is unnecessary.
 *
 * Tradeoff: if membership is revoked, access may persist until TTL expires. Keep TTL small.
 * This is consistent with other short-lived caching already used in dashboard endpoints.
 */
const MEMBERSHIP_EXISTS_CACHE_TTL_MS = 10_000;
const MEMBERSHIP_EXISTS_CACHE_MAX = 500;
let membershipExistsCache: Map<string, { at: number; ok: boolean }> | null = null;

function membershipCacheKey(params: { orgId: string; userId: string }): string {
  return `org:${params.orgId}:user:${params.userId}`;
}

function getCachedMembershipExists(key: string): boolean | null {
  membershipExistsCache = membershipExistsCache ?? new Map();
  const e = membershipExistsCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > MEMBERSHIP_EXISTS_CACHE_TTL_MS) {
    membershipExistsCache.delete(key);
    return null;
  }
  return e.ok;
}

function setCachedMembershipExists(key: string, ok: boolean) {
  membershipExistsCache = membershipExistsCache ?? new Map();
  membershipExistsCache.set(key, { at: Date.now(), ok });
  // Best-effort bound; drop oldest-ish entry (O(n), rare).
  if (membershipExistsCache.size > MEMBERSHIP_EXISTS_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of membershipExistsCache.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) membershipExistsCache.delete(oldestKey);
  }
}

/**
 * Drop the cached membership answer for one (workspace, person).
 *
 * The cache above trades correctness for latency on a ten-second window, and for a *read* that is a
 * fair trade. For a removal it is not: "remove" is a security action, and a removed member who can
 * still read the workspace for another ten seconds is the one case where the reader is entitled to
 * expect the click to have taken effect by the time the page repaints. Every route that adds or
 * removes a membership calls this immediately after the write.
 *
 * Per-process, like the cache: on a multi-instance deploy the other instances still expire on their
 * own TTL, so this shortens the window rather than closing it everywhere. That is why it is a
 * companion to the membership check in `tryResolveUserActor`, not a substitute for it.
 */
/**
 * Is this person currently a member of this workspace?
 *
 * The same short-lived cache the session resolvers use, so `membershipChanged()` invalidates every
 * path at once. Exported because API keys need the identical question: a key acts *as* the person
 * who created it, so if they are removed from the workspace the key has to stop working too —
 * otherwise "remove member" only removes the browser and leaves the automation running.
 *
 * Fails CLOSED on a lookup error, unlike the session resolvers, which fall back to the person's own
 * workspace. A key has no other workspace to fall back to, and refusing one request is recoverable
 * where granting it is not.
 */
export async function isActiveMember(params: { orgId: string; userId: string }): Promise<boolean> {
  const { orgId, userId } = params;
  if (!Types.ObjectId.isValid(orgId) || !Types.ObjectId.isValid(userId)) return false;
  const cacheKey = membershipCacheKey({ orgId, userId });
  const cached = getCachedMembershipExists(cacheKey);
  if (typeof cached === "boolean") return cached;
  try {
    await connectMongo();
    const ok = Boolean(
      await OrgMembershipModel.exists({
        orgId: new Types.ObjectId(orgId),
        userId: new Types.ObjectId(userId),
        isDeleted: { $ne: true },
      }),
    );
    setCachedMembershipExists(cacheKey, ok);
    return ok;
  } catch {
    // Not cached: a blip must not lock a key out for the next ten seconds of requests.
    return false;
  }
}

/**
 * `User.metadata.activeOrgId` — the workspace this person last chose, on any device.
 *
 * Cached because the fast resolvers exist to avoid exactly this read, and skipping it is what made
 * them disagree with the full one (see `resolveActiveOrgId`). A short TTL is safe: the only thing
 * that moves this value is `/org/switch`, which writes the **cookie** at the same time, and the
 * cookie takes precedence — so a stale entry can only matter on a device that has no cookie yet,
 * which is the case this read exists to serve in the first place.
 */
const ACTIVE_ORG_META_TTL_MS = 60_000;
let activeOrgMetaCache: Map<string, { at: number; orgId: string }> | null = null;

async function readActiveOrgMetadata(userId: string): Promise<string> {
  activeOrgMetaCache = activeOrgMetaCache ?? new Map();
  const hit = activeOrgMetaCache.get(userId);
  if (hit && Date.now() - hit.at < ACTIVE_ORG_META_TTL_MS) return hit.orgId;
  try {
    const u = (await UserModel.findOne({ _id: new Types.ObjectId(userId) }).select({ metadata: 1 }).lean()) as
      | { metadata?: { activeOrgId?: unknown } | null }
      | null;
    const raw = u?.metadata && typeof u.metadata === "object" ? u.metadata.activeOrgId : null;
    const orgId = typeof raw === "string" && Types.ObjectId.isValid(raw.trim()) ? raw.trim() : "";
    activeOrgMetaCache.set(userId, { at: Date.now(), orgId });
    if (activeOrgMetaCache.size > 500) {
      const oldest = [...activeOrgMetaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) activeOrgMetaCache.delete(oldest);
    }
    return orgId;
  } catch {
    return "";
  }
}

/** Forget the cached "last chosen workspace" for one person — called when they switch. */
export function activeOrgChanged(userId: string | Types.ObjectId): void {
  try {
    activeOrgMetaCache?.delete(String(userId));
  } catch {
    // A cache that cannot be cleared must not fail the switch that cleared it.
  }
}

/**
 * Which workspace is this signed-in request acting in?
 *
 * **One answer, one precedence, every resolver.** There used to be three implementations that
 * disagreed, and the disagreement was silent and destructive: the full resolver ended at
 * cookie > metadata > claim, while the fast ones were `cookie || claim` and never read metadata at
 * all. On a device with no `ld_active_org` cookie — a second laptop, cleared cookies — whose
 * `metadata.activeOrgId` pointed at a team workspace, the sidebar, the plan and the credits
 * snapshot (fast) said "Personal" while `POST /api/docs` and `POST /api/uploads` (full) wrote to
 * the **team** workspace. The file landed where colleagues could read it, under a UI that said it
 * was private.
 *
 * Order, each candidate confirmed against a live membership before it is accepted:
 * 1. the active-org cookie — this browser's choice, and server-issued;
 * 2. `User.metadata.activeOrgId` — the last choice made anywhere, which is what a new device wants;
 * 3. the JWT claim — issued at sign-in and long-lived, so the weakest of the three;
 * 4. the person's own workspace.
 *
 * A membership lookup that fails is treated as "not confirmed" and falls through rather than being
 * accepted, so a database blip narrows access to the person's own workspace instead of widening it
 * to one they may no longer belong to.
 */
async function resolveActiveOrgId(params: {
  request: Request;
  userId: string;
  claimOrgId: string;
  personalOrgId: string | null;
}): Promise<string | null> {
  const { request, userId, claimOrgId, personalOrgId } = params;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieRaw = readCookie(cookieHeader, ACTIVE_ORG_COOKIE);
  const cookieOrgId = typeof cookieRaw === "string" ? cookieRaw.trim() : "";

  for (const candidate of [cookieOrgId, await readActiveOrgMetadata(userId), claimOrgId]) {
    if (!candidate || !Types.ObjectId.isValid(candidate)) continue;
    // Their own workspace needs no membership round-trip: it is theirs by construction.
    if (personalOrgId && candidate === personalOrgId) return candidate;
    if (await isActiveMember({ orgId: candidate, userId })) return candidate;
  }
  return personalOrgId;
}

export function membershipChanged(params: { orgId: string | Types.ObjectId; userId: string | Types.ObjectId }): void {
  try {
    membershipExistsCache?.delete(membershipCacheKey({ orgId: String(params.orgId), userId: String(params.userId) }));
  } catch {
    // A cache that cannot be cleared must not fail the write that cleared it.
  }
}

/**
 * Short-lived in-memory personal-org cache.
 *
 * Why: `ensurePersonalOrgForUserId()` is intentionally idempotent but not cheap (read + upsert).
 * Many auth-required routes only need the personal org id for legacy-scoping decisions; caching
 * avoids repeating those DB calls on every request.
 */
const PERSONAL_ORG_CACHE_TTL_MS = 5 * 60_000;
const PERSONAL_ORG_CACHE_MAX = 500;
let personalOrgCache: Map<string, { at: number; orgId: string }> | null = null;

function getCachedPersonalOrgId(userId: string): string | null {
  personalOrgCache = personalOrgCache ?? new Map();
  const e = personalOrgCache.get(userId);
  if (!e) return null;
  if (Date.now() - e.at > PERSONAL_ORG_CACHE_TTL_MS) {
    personalOrgCache.delete(userId);
    return null;
  }
  return e.orgId;
}

function setCachedPersonalOrgId(userId: string, orgId: string) {
  personalOrgCache = personalOrgCache ?? new Map();
  personalOrgCache.set(userId, { at: Date.now(), orgId });
  if (personalOrgCache.size > PERSONAL_ORG_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of personalOrgCache.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) personalOrgCache.delete(oldestKey);
  }
}

async function resolvePersonalOrgIdCached(userId: string): Promise<string> {
  const cached = getCachedPersonalOrgId(userId);
  if (cached) return cached;
  // Prefer a cheap read (no membership upsert) for the common case.
  const existing = await OrgModel.findOne({
    type: "personal",
    personalForUserId: new Types.ObjectId(userId),
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean();
  if (existing?._id) {
    const id = String(existing._id);
    setCachedPersonalOrgId(userId, id);
    return id;
  }
  // Fallback: ensure it exists (bootstrap/backfill path).
  const ensured = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(userId) });
  const id = String(ensured.orgId);
  setCachedPersonalOrgId(userId, id);
  return id;
}

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
  | {
      kind: "user";
      userId: string;
      orgId: string;
      personalOrgId: string;
      /**
       * Set when this actor came from an API key rather than a signed-in session.
       *
       * An API key resolves to the member who created it, which is what makes agent actions
       * attributable — but it means a key silently carries everything its owner can do, including
       * powers the key was never scoped for. `requireAdmin` refuses a key-derived actor for exactly
       * that reason: an admin who connects an agent should not thereby hand it the admin console.
       *
       * Any future gate that authorises on who someone *is*, rather than on a key scope, must check
       * this too.
       */
      viaApiKey?: { keyId: string; scopes: string[] };
    }
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
 * Disabled accounts, cached briefly.
 *
 * Read on every signed-in request, so it is a `_id`-and-two-fields lookup behind a short TTL: long
 * enough that a busy page costs one read, short enough that "delete my account" takes effect while
 * the person is still looking at the confirmation. `accountDisabledChanged()` drops the entry so the
 * request that disables an account does not have to wait out the TTL.
 */
const ACCOUNT_DISABLED_TTL_MS = 15_000;
let accountDisabledCache: Map<string, { at: number; disabled: boolean }> | null = null;

async function isAccountDisabled(userId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(userId)) return false;
  accountDisabledCache = accountDisabledCache ?? new Map();
  const hit = accountDisabledCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < ACCOUNT_DISABLED_TTL_MS) return hit.disabled;
  try {
    await connectMongo();
    const u = (await UserModel.findOne({ _id: new Types.ObjectId(userId) })
      .select({ isActive: 1, deletionRequestedAt: 1 })
      .lean()) as { isActive?: unknown; deletionRequestedAt?: unknown } | null;
    // Only explicit state disables: a row this query cannot see (a test double, a replica that has
    // not caught up) must not sign a real person out. The purge leaves an anonymised tombstone
    // carrying these flags rather than deleting the row, so a purged account still lands here.
    const disabled = Boolean(u) && (u!.isActive === false || Boolean(u!.deletionRequestedAt));
    accountDisabledCache.set(userId, { at: now, disabled });
    if (accountDisabledCache.size > 500) {
      const oldest = [...accountDisabledCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) accountDisabledCache.delete(oldest);
    }
    return disabled;
  } catch {
    // A database blip must not sign everybody out.
    return false;
  }
}

/** Forget the cached state for one account (called when it is disabled or restored). */
export function accountDisabledChanged(userId: string): void {
  accountDisabledCache?.delete(userId);
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
    // A disabled or deleted account must stop working everywhere at once. Sign-in already refuses
    // it, but a JWT session issued earlier stays valid until it expires, so the token alone cannot
    // be trusted: every signed-in path goes through here, so this is where the session ends.
    if (await isAccountDisabled(resolvedUserId)) return null;
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
  // API keys first: an `lnk_` bearer is the workspace, no session or cookie involved.
  const keyActor = await tryResolveApiKeyActor(request);
  if (keyActor) return keyActor;
  const session = await tryGetSessionClaims(request);
  if (!session?.userId) return null;

  await connectMongo();
  const fallbackOrg = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(session.userId) });
  const personalOrgId = String(fallbackOrg.orgId);

  // One rule for which workspace a request is in, shared with every other resolver — see
  // `resolveActiveOrgId`. This used to be spelled out here (claim, then DB metadata, then cookie,
  // each overriding the last) while the fast resolvers used `cookie || claim` and never read
  // metadata, so one request resolved to different workspaces depending on which resolver the
  // route it hit happened to call.
  const orgId =
    (await resolveActiveOrgId({
      request,
      userId: session.userId,
      claimOrgId: typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "",
      personalOrgId,
    })) ?? personalOrgId;

  return { kind: "user", userId: session.userId, orgId, personalOrgId };
}

/**
 * Fast path: resolve a signed-in user actor without the full resolver's writes.
 *
 * What it still avoids, and why it is worth having: `tryResolveUserActor()` opens with
 * `ensurePersonalOrgForUserId()` — a read plus an upsert — on every request before it has any idea
 * whether the answer will be used. This path does the same membership-checked workspace resolution
 * (`resolveActiveOrgId`, so cookie > metadata > claim, same as everywhere else) off short-lived
 * caches, and mints nothing.
 *
 * Use this for performance-sensitive, read-only endpoints where:
 * - the route still scopes data by orgId, and
 * - you can tolerate falling back to full `resolveActor()` when no workspace is confirmed.
 */
export async function tryResolveUserActorFast(request: Request): Promise<Actor | null> {
  const keyActor = await tryResolveApiKeyActor(request);
  if (keyActor) return keyActor;
  const session = await tryGetSessionClaims(request);
  if (!session?.userId) return null;

  // The same workspace this request would resolve to anywhere else — see `resolveActiveOrgId`.
  // This used to be `cookie || claim`, which skipped `metadata.activeOrgId` and is what made the
  // fast paths disagree with the full one about which workspace a request belonged to.
  await connectMongo();
  const orgId = await resolveActiveOrgId({
    request,
    userId: session.userId,
    claimOrgId: typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "",
    // The fast path deliberately does not mint a personal org (that is a write); with no confirmed
    // candidate it refuses and the caller falls back to the full resolver, as it always did.
    personalOrgId: null,
  });
  if (!orgId) return null;

  // This used to be `personalOrgId: orgId`, on the reasoning that hot read paths did not need the
  // field. They did — they just never said so out loud. Dozens of routes ask "is this the person's
  // own workspace" as `actor.orgId === actor.personalOrgId`, to widen a query to legacy org-less
  // rows or to pick the wording on a billing header, and copying the active org into the field made
  // that question answer `true` in every workspace: a team workspace was told it was personal
  // (/api/plan, /api/agent/status) and team queries were widened to the caller's own old rows.
  // `apiKeyActor` carried the identical bug and was fixed the same way.
  //
  // The cost is one `_id`-projected indexed read behind a five-minute cache (`personalOrgCache`),
  // not the read-plus-upsert the full resolver does, so the shortcut this path exists for is intact.
  const personalOrgId = await resolvePersonalOrgIdCached(session.userId);
  return { kind: "user", userId: session.userId, orgId, personalOrgId };
}

/**
 * The fast path, under the name the routes that needed a true `personalOrgId` reached for.
 *
 * It was a second copy of `tryResolveUserActorFast` that differed in one line: it resolved the real
 * personal org instead of copying the active one. Now that the plain fast path no longer fakes the
 * field, the two are the same function, and the names only recorded which routes had noticed the
 * difference. Kept as an alias because its callers are scattered across the API surface; a second
 * body is how the resolvers came to disagree in the first place.
 */
export async function tryResolveUserActorFastWithPersonalOrg(request: Request): Promise<Actor | null> {
  return await tryResolveUserActorFast(request);
}

/**
 * Dev/test-only auth bypass for route testing.
 *
 * Only applies when there is NO authenticated session user and is intentionally blocked in
 * production environments. Returns `null` when the bypass is not active.
 */
async function tryResolveTestBypassActor(): Promise<Actor | null> {
  const bypass =
    (process.env.API_TEST_BYPASS_AUTH ?? "").trim().toLowerCase() === "1" ||
    (process.env.API_TEST_BYPASS_AUTH ?? "").trim().toLowerCase() === "true";
  const testUserId = (process.env.API_TEST_USER_ID ?? "").trim();
  if (!bypass || process.env.NODE_ENV === "production" || !testUserId || !Types.ObjectId.isValid(testUserId)) {
    return null;
  }
  await connectMongo();
  const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(testUserId) });
  const personalOrgId = String(orgId);
  return { kind: "user", userId: testUserId, orgId: personalOrgId, personalOrgId };
}

/**
 * Resolve an **existing** temp user from the temp-user headers.
 *
 * Returns `null` when the headers are missing/invalid or the temp user does not exist.
 * Never creates a temp user.
 */
async function tryResolveExistingTempActor(request: Request): Promise<Actor | null> {
  const tempId = header(request, TEMP_USER_ID_HEADER);
  const tempSecret = header(request, TEMP_USER_SECRET_HEADER);
  if (!tempId || !tempSecret || !Types.ObjectId.isValid(tempId)) return null;

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(tempId), isTemp: true })
    .select({ _id: 1, tempSecretHash: 1 })
    .lean();
  if (!u || !verifyTempUserSecret({ secret: tempSecret, secretHash: u.tempSecretHash ?? null })) return null;

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

/**
 * Uncached actor resolution (see `resolveActor()` for the contract).
 *
 * This never reads or writes `ACTOR_CACHE`, which makes it safe to call from inside another
 * cached resolver's pending promise. Calling `resolveActor()` from such a promise would find the
 * caller's own promise in the cache and await itself, hanging the request forever.
 */
async function resolveActorUncached(request: Request): Promise<Actor> {
  // 1) Authenticated user (preferred)
  const userActor = await tryResolveUserActor(request);
  if (userActor) return userActor;

  // Dev/test-only bypass for route testing (no-op in production).
  const bypassActor = await tryResolveTestBypassActor();
  if (bypassActor) return bypassActor;

  // 2) Temp user via headers
  const tempActor = await tryResolveExistingTempActor(request);
  if (tempActor) return tempActor;

  // 3) Create a new temp user
  // Charged only here, after both identity paths came up empty: a caller that keeps sending the
  // temp-user headers it was given never pays again, so a returning visitor is never throttled.
  await guardTempWorkspaceCreation(request);
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
}

/**
 * Resolve the current "actor" for an API request:
 * - signed-in user (NextAuth session), else
 * - temp user (by headers), else
 * - create a new temp user.
 *
 * The result is cached per `Request` so multiple resolvers on the same request share one
 * resolution (and mint at most one temp user).
 */
export async function resolveActor(request: Request): Promise<Actor> {
  const cached = ACTOR_CACHE.get(request);
  if (cached) return await cached;
  const p = resolveActorUncached(request);
  ACTOR_CACHE.set(request, p);
  return await p;
}

/**
 * Resolve an actor that **already exists**, or `null`.
 *
 * Intended for fire-and-forget / public endpoints (e.g. metrics ingestion) that must never mint
 * identities: this returns the signed-in user actor, or the temp actor identified by the
 * temp-user headers when that temp user exists, and otherwise returns `null` WITHOUT creating a
 * new temp user, org or membership. (In non-production, the `API_TEST_BYPASS_AUTH` test bypass
 * is honored the same way `resolveActor()` honors it.)
 *
 * If `resolveActor()` already ran for this `Request`, its cached result is reused; this function
 * never writes the cache itself.
 */
export async function resolveExistingActor(request: Request): Promise<Actor | null> {
  const cached = ACTOR_CACHE.get(request);
  if (cached) return await cached;

  const userActor = await tryResolveUserActor(request);
  if (userActor) return userActor;

  const bypassActor = await tryResolveTestBypassActor();
  if (bypassActor) return bypassActor;

  return await tryResolveExistingTempActor(request);
}

/**
 * Faster actor resolution for stats/analytics endpoints.
 *
 * Goal: avoid repeated DB work on hot read paths. This prefers already-server-issued org context:
 * - active-org cookie (set only after membership validation)
 * - NextAuth JWT claim `activeOrgId`
 *
 * Falls back to the full (uncached) resolver when we can't safely determine org context.
 * NOTE: fallbacks must call `resolveActorUncached()`, not `resolveActor()`: this function stores
 * its own pending promise in `ACTOR_CACHE`, so `resolveActor()` would await that same promise.
 */
export async function resolveActorForStats(request: Request): Promise<Actor> {
  const cached = ACTOR_CACHE.get(request);
  if (cached) return await cached;

  const p: Promise<Actor> = (async () => {
    const keyActor = await tryResolveApiKeyActor(request);
    if (keyActor) return keyActor;
    const session = await tryGetSessionClaims(request);
    if (!session?.userId) return await resolveActorUncached(request);

    // One rule for which workspace a request is in — see `resolveActiveOrgId`. Membership is
    // confirmed there, cached, and re-asked the moment `membershipChanged()` fires.
    await connectMongo();
    const orgId = await resolveActiveOrgId({
      request,
      userId: session.userId,
      claimOrgId: typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "",
      // No confirmed candidate: fall back to the full resolver, which also ensures the personal
      // org exists. That is what this path has always done when org context was missing.
      personalOrgId: null,
    });
    if (!orgId) return await resolveActorUncached(request);

    // Same correction as `tryResolveUserActorFast`: this returned `personalOrgId: orgId`, which is
    // not a stable placeholder but a wrong answer — `/api/plan` serializes `orgId === personalOrgId`
    // as `isPersonalOrg`, so the Billing tab greeted every team workspace with "Your personal
    // workspace is billed on its own". Cached (five minutes, `_id` only), so the round-trip this
    // resolver was written to skip — `ensurePersonalOrgForUserId`'s upsert — is still skipped.
    const personalOrgId = await resolvePersonalOrgIdCached(session.userId);
    return { kind: "user", userId: session.userId, orgId, personalOrgId };
  })();

  ACTOR_CACHE.set(request, p);
  return await p;
}
