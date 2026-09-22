/**
 * The early-access queue, as a gate a request handler can call.
 *
 * The queue was enforced in exactly one place: `src/app/(app)/layout.tsx` redirected a queued
 * visitor to `/waitlist`. That is the *page shell*, and a page shell is not an access control —
 * it decides what a browser is shown, not what an account may do. A queued account still holds a
 * valid NextAuth cookie, and `resolveActor` never looked at `accessStatus` at all, so
 * `POST /api/docs`, `POST /api/uploads`, `POST /api/uploads/:id/process?quality=advanced` and
 * `POST /api/docs/:id/links` all answered normally: `forbidUnlessOrgRole` passes because a queued
 * person owns their own personal workspace, and there is no middleware in front of `/api/*`. So
 * the queue metered the front door while the paid AI processing ran through the side one.
 *
 * What this module is:
 *
 * - **One answer, shared.** The layout and the API now decide from the same cached read, so the
 *   screen and the endpoint cannot disagree about whether someone is in.
 * - **The decision is `accessStatusOf`, not a second copy of it.** Who skips the queue — admins,
 *   accounts that predate it, rows with no status — is settled in `src/lib/waitlist/waitlist.ts`
 *   and must stay settled in one place.
 * - **A returned response, not a thrown error**, for the same reason as `forbidApiKey`: these
 *   routes have their own error shapes, and a guard that throws lands in whichever catch is
 *   nearest.
 *
 * It does **not** gate reads. The queue exists to meter what costs the operator money and fills
 * the operator's storage; a queued person must still be able to load `/waitlist`, read their
 * account settings, see their position and sign out. Call this from the mutating entry points
 * only.
 */
import { Types } from "mongoose";
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import type { WaitlistBlockedReason } from "@/lib/waitlist/waitlist";
import { accessStatusOf, type AccessStatus } from "@/lib/waitlist/waitlist";
import type { Actor } from "@/lib/gating/actor";

/**
 * Same shape and same reasoning as the disabled-account cache in `src/lib/gating/actor.ts`: an
 * `_id`-and-two-fields lookup behind a short TTL, long enough that one page's burst of API calls
 * costs a single read, short enough that an admin clicking Approve frees the person while they are
 * still looking at the waiting screen. Fifteen seconds rather than the sixty used for the active
 * workspace, because this one is the difference between "let me in" working and not.
 */
const ACCESS_STATUS_TTL_MS = 15_000;
const ACCESS_STATUS_CACHE_MAX = 500;
let accessStatusCache: Map<string, { at: number; status: AccessStatus }> | null = null;

/**
 * This account's queue status, cached.
 *
 * Fails **open** on a lookup error, like `isAccountDisabled` next door and for the same reason:
 * the queue is off for most deployments and empty for every account that predates it, so a
 * database blip that refused every mutation would lock out the whole product to enforce a rule
 * that, nine times in ten, applies to nobody. A queued account slipping through one request while
 * Mongo is unreachable is the cheaper failure.
 */
export async function readAccessStatus(userId: string): Promise<AccessStatus> {
  if (!Types.ObjectId.isValid(userId)) return "approved";
  accessStatusCache = accessStatusCache ?? new Map();
  const now = Date.now();
  const hit = accessStatusCache.get(userId);
  if (hit && now - hit.at < ACCESS_STATUS_TTL_MS) return hit.status;
  try {
    await connectMongo();
    const user = (await UserModel.findOne({ _id: new Types.ObjectId(userId) })
      .select({ accessStatus: 1, role: 1 })
      .lean()) as { accessStatus?: unknown; role?: unknown } | null;
    const status = accessStatusOf(user);
    /**
     * Only the permissive answer is cached.
     *
     * Caching "approved" is free: the worst case is somebody keeps access for fifteen seconds after
     * being un-approved, and nothing un-approves people. Caching "waitlisted" is what hurt, in two
     * ways that both land on the person the moment they are finally let in:
     *
     * - An admin clicks Approve and the account stays locked out for the rest of the TTL, on the
     *   one screen where "let me in" working is the entire product.
     * - Worse, it loops. `/waitlist` reads Mongo directly, sees "approved" and redirects to `/`,
     *   which still has "waitlisted" cached and redirects back. `accessStatusChanged` cannot save
     *   it: the cache is per process, and a dev server or a multi-instance deploy answers the two
     *   requests from different ones. The browser gives up with ERR_TOO_MANY_REDIRECTS.
     *
     * A queued account is, by definition, barely using the product — every mutation it attempts is
     * refused anyway — so re-reading one `_id`-keyed row per request is a cost nobody pays at
     * volume. The cache exists to spare a page's burst of API calls, and an approved account is
     * what generates those.
     */
    if (status === "approved") accessStatusCache.set(userId, { at: now, status });
    else accessStatusCache.delete(userId);
    if (accessStatusCache.size > ACCESS_STATUS_CACHE_MAX) {
      const oldest = [...accessStatusCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) accessStatusCache.delete(oldest);
    }
    return status;
  } catch {
    // Not cached: a blip must not hold an approved person out for the next fifteen seconds either.
    return "approved";
  }
}

/**
 * Forget the cached status for one account — call it straight after approving someone.
 *
 * Per-process, like every cache in `actor.ts`: on a multi-instance deploy the other instances still
 * expire on their own TTL, so this shortens the window rather than closing it everywhere.
 */
export function accessStatusChanged(userId: string | Types.ObjectId): void {
  try {
    accessStatusCache?.delete(String(userId));
  } catch {
    // A cache that cannot be cleared must not fail the approval that cleared it.
  }
}

/** Is the account behind this actor still in the queue? */
export async function isWaitlistedActor(actor: Actor): Promise<boolean> {
  // A temp actor is the anonymous pre-sign-up flow. There is no account to have queued and no
  // admin who could approve one, so the queue has nothing to say about it — the plan limits on a
  // temp workspace are what bound that path.
  if (actor.kind !== "user") return false;
  // An API key resolves to the member who issued it, so a queued person's key has to stop at the
  // same door their browser does; otherwise "you are in the queue" only applies to the browser.
  return (await readAccessStatus(actor.userId)) === "waitlisted";
}

/**
 * A 403 when this actor is still in the early-access queue, or null to continue.
 *
 * @param what - names the action, e.g. "upload a document". A caller told only "forbidden" retries;
 *   one told which action is held back can say so on screen.
 * @param opts.reason - tags the redirect so `/waitlist` can explain itself. Without it the person
 *   presses Upgrade, the page silently changes under them, and nothing says why — which reads as a
 *   broken button rather than a rule. The code is looked up in a fixed table there, never rendered.
 */
export async function forbidWaitlisted(
  actor: Actor,
  what: string,
  opts?: { reason?: WaitlistBlockedReason },
): Promise<NextResponse | null> {
  if (!(await isWaitlistedActor(actor))) return null;
  const reason = opts?.reason;
  return NextResponse.json(
    {
      error: "WAITLISTED",
      // `redirectTo` so the dashboard's fetch wrapper can send the browser to the same screen the
      // page shell would have, instead of surfacing a bare 403 the person cannot act on.
      redirectTo: reason ? `/waitlist?blocked=${encodeURIComponent(reason)}` : "/waitlist",
      message: `Your account is on the early-access waitlist and cannot ${what} yet.`,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
