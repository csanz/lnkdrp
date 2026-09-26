/**
 * The lock review: what locking or unlocking a room actually does, computed before the write, plus
 * the signed token that proves the person saw it (docs/prds/lnkdrp-locked-projects.md, decision 31).
 *
 * Locking a room that already holds documents and readers is a review, not a confirm. Counting who
 * loses access while making the locker assemble the keeper list from nothing is how a lock breaks a
 * week, so this also preselects the keepers from what has already happened in the room: its creator,
 * everybody who uploaded one of its documents, and everybody with a `project.*` activity row for it.
 * The actor is always in.
 *
 * The token is not authorization. The caller has already passed the by-id filter and the workspace
 * role check by the time `PATCH` looks at it; what it proves is that the review was fetched for THIS
 * room, by THIS person, for THIS direction, in the last few minutes. That is the one thing a server
 * cannot otherwise know, and the reason it matters is decision 26: a lock is not an unshare, and a
 * room can be invisible to colleagues and open to the world at the same time. Nobody should reach
 * that state without having been shown the `/p/:shareId` URL that is still live.
 *
 * It deliberately does NOT bind the counts. The numbers can move between the review and the confirm
 * (somebody uploads, a link expires), and a token that refused on a changed count would send the
 * person round the dialog again to be shown a number they already accepted the shape of.
 */
import crypto from "node:crypto";
import { Types } from "mongoose";

import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { DocModel } from "@/lib/models/Doc";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { ProjectMembershipModel } from "@/lib/models/ProjectMembership";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";
import { NotificationQueueModel } from "@/lib/models/NotificationQueue";
// The cap lives in one place: `lockScope.ts` owns the numbers this feature enforces.
import { LOCKED_ROOM_MEMBER_CAP } from "@/lib/projects/lockScope";

/** Which direction a review is for. A token minted for one can never confirm the other. */
export type LockTarget = "locked" | "workspace";

export const LOCK_REVIEW_PURPOSE = "project_lock_review";
/**
 * Ten minutes: long enough to read the dialog, pick the keepers and think about the public link,
 * short enough that a token left in a closed tab does not confirm a lock tomorrow.
 */
export const LOCK_REVIEW_TTL_MS = 10 * 60 * 1000;

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 1024;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_KEY_SALT = "lnkdrp-project-lock-review";
const TOKEN_KEY_INFO = "project-lock-review-hkdf:v1";
/** Dev fallback so local envs do not crash. Public by construction; never reached in production. */
const DEV_FALLBACK_SECRET = "dev-lnkdrp-project-lock-review-secret";

/**
 * The signing key.
 *
 * `NEXTAUTH_SECRET` is the fallback behind several independent derivations in this codebase, so it
 * is never used raw: HKDF with a salt and info unique to this purpose means a key here cannot verify
 * a realtime ticket, an invite link or an unsubscribe link, and vice versa.
 */
function signingSecret(): string {
  const master = (process.env.NEXTAUTH_SECRET ?? "").trim() || DEV_FALLBACK_SECRET;
  return Buffer.from(crypto.hkdfSync("sha256", master, TOKEN_KEY_SALT, TOKEN_KEY_INFO, 32)).toString("base64url");
}

/** HMAC one payload segment with the purpose-bound key. */
function sign(segment: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(segment).digest("base64url");
}

/** Mint a review token for one room, one person and one direction. */
export function createLockReviewToken(params: {
  projectId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  target: LockTarget;
  now?: number;
  ttlMs?: number;
}): string {
  const now = typeof params.now === "number" ? params.now : Date.now();
  const ttl = typeof params.ttlMs === "number" && params.ttlMs > 0 ? params.ttlMs : LOCK_REVIEW_TTL_MS;
  const payload = {
    v: TOKEN_VERSION,
    p: LOCK_REVIEW_PURPOSE,
    r: String(params.projectId),
    u: String(params.userId),
    t: params.target,
    e: now + ttl,
  };
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${segment}.${sign(segment)}`;
}

export type LockReviewFailure = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_room";

/**
 * Verify a review token against the room, the person and the direction it was minted for.
 *
 * Signature before expiry, and both before the payload is believed: an expired token whose signature
 * does not check out is forged, not stale.
 */
export function verifyLockReviewToken(
  raw: unknown,
  expected: { projectId: string | Types.ObjectId; userId: string | Types.ObjectId; target: LockTarget; now?: number },
): { ok: true } | { ok: false; reason: LockReviewFailure } {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const segment = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!BASE64URL_RE.test(segment) || !BASE64URL_RE.test(signature)) return { ok: false, reason: "malformed" };

  const a = Buffer.from(signature);
  const b = Buffer.from(sign(segment));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  const { v, p, r, u, t, e } = parsed as Record<string, unknown>;
  if (v !== TOKEN_VERSION || p !== LOCK_REVIEW_PURPOSE) return { ok: false, reason: "malformed" };
  if (typeof e !== "number" || !Number.isFinite(e)) return { ok: false, reason: "malformed" };
  const now = typeof expected.now === "number" ? expected.now : Date.now();
  if (now >= e) return { ok: false, reason: "expired" };
  if (r !== String(expected.projectId) || u !== String(expected.userId) || t !== expected.target) {
    return { ok: false, reason: "wrong_room" };
  }
  return { ok: true };
}

/** One person a review names: somebody who loses sight of the room, or a preselected keeper. */
export type LockReviewPerson = {
  userId: string;
  name: string | null;
  email: string | null;
  /** Their workspace role, because decision 24 means a room can need a role none of its people hold. */
  orgRole: string | null;
  /** Why a keeper is preselected: they made the room, uploaded to it, or acted in it. */
  because?: "creator" | "uploader" | "acted" | "you" | "member";
};

export type LockReview = {
  target: LockTarget;
  /**
   * Whether `PATCH` will require the token. An empty room with no links has nothing to review, and
   * making somebody confirm a dialog about zero documents and zero readers teaches them to click
   * through the one that matters.
   */
  reviewRequired: boolean;
  /** Minted for this room, person and direction; `PATCH` refuses without it when review is required. */
  token: string;
  members: {
    /** Workspace members who lose sight of the room, by name (they are not preselected keepers). */
    losing: LockReviewPerson[];
    /** Preselected from what has already happened in the room. Unchecking a name removes access. */
    keepers: LockReviewPerson[];
    /** Live grants the room already holds, which an unlock keeps (decision 31). */
    current: LockReviewPerson[];
    cap: number;
  };
  docs: {
    /** Documents whose home is this room, and which therefore leave workspace listings. */
    leavingWorkspaceListings: number;
    /** Of those, how many also live in another room and stay visible there (decision 12). */
    alsoInAnotherRoom: number;
  };
  links: {
    /** Live, unarchived, unexpired links on this room. */
    live: number;
    /** The room's own `/p/:shareId` path while its public page is on, so the dialog can show it. */
    publicPath: string | null;
    shareEnabled: boolean;
  };
  slack: {
    /** Channels this room is routed to. Empty and locked means Slack posts stop (decision 20). */
    mappedChannels: string[];
    postsWillStop: boolean;
  };
  notifications: {
    /** Pending emails about this room that belong to people who will not be in it. */
    pendingRowsDropped: number;
  };
};

/** A row's ObjectId as a string, or "" when it is not one. */
function idOf(v: unknown): string {
  return v instanceof Types.ObjectId ? String(v) : typeof v === "string" ? v : "";
}

/**
 * Compute the review for one room.
 *
 * The project row is passed in rather than read here: every caller has already resolved it through
 * `src/lib/projects/scope.ts`, and a second read in this helper would be a project read with no
 * visibility clause sitting one import away from the lock itself.
 */
export async function lockReview(params: {
  orgId: Types.ObjectId | string;
  actorUserId: Types.ObjectId | string;
  project: {
    _id: unknown;
    name?: unknown;
    shareId?: unknown;
    shareEnabled?: unknown;
    userId?: unknown;
    visibility?: unknown;
  };
  target: LockTarget;
  now?: number;
}): Promise<LockReview> {
  const orgId = new Types.ObjectId(String(params.orgId));
  const projectId = new Types.ObjectId(String(params.project._id));
  const actorUserId = String(params.actorUserId);

  const [orgMembers, grants, homeDocs, liveLinks, slackRows] = await Promise.all([
    OrgMembershipModel.find({ orgId, isDeleted: { $ne: true } })
      .select({ userId: 1, role: 1 })
      .lean() as Promise<Array<{ userId?: unknown; role?: unknown }>>,
    ProjectMembershipModel.find({ orgId, projectId, isDeleted: { $ne: true } })
      .select({ userId: 1, via: 1 })
      .lean() as Promise<Array<{ userId?: unknown; via?: unknown }>>,
    // The documents whose HOME is this room (decision 12's rule), which are the ones that leave
    // workspace listings. `projectIds` is read too so the dialog can say how many stay visible
    // somewhere else rather than leaving the person to infer it.
    DocModel.find({
      orgId,
      isDeleted: { $ne: true },
      $or: [{ primaryProjectId: projectId }, { primaryProjectId: null, projectIds: projectId }],
    })
      .select({ _id: 1, projectIds: 1 })
      .limit(2000)
      .lean() as Promise<Array<{ _id?: unknown; projectIds?: unknown }>>,
    ShareLinkModel.countDocuments({
      orgId,
      projectId,
      enabled: true,
      archivedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(params.now ?? Date.now()) } }],
    }),
    SlackConnectionModel.find({ orgId, status: "active", projectIds: projectId })
      .select({ channelName: 1 })
      .lean() as Promise<Array<{ channelName?: unknown }>>,
  ]);

  const grantedIds = new Set(grants.map((g) => idOf(g.userId)).filter(Boolean));
  const docIds = homeDocs.map((d) => idOf(d._id)).filter(Boolean);
  const alsoInAnotherRoom = homeDocs.filter((d) => {
    const ids = Array.isArray(d.projectIds) ? d.projectIds.map((x) => idOf(x)) : [];
    return ids.some((x) => x && x !== String(projectId));
  }).length;

  // The keepers, preselected from history (decision 31): the person who made the room, everybody who
  // uploaded one of its documents, and everybody who has a `project.*` row for it. Read as ids
  // first, then resolved to names in one query with the losers.
  const [uploaders, actors, pendingRowsDropped] = await Promise.all([
    docIds.length
      ? (UploadModel.find({ orgId, docId: { $in: docIds.map((id) => new Types.ObjectId(id)) } })
          .select({ userId: 1 })
          .limit(2000)
          .lean() as Promise<Array<{ userId?: unknown }>>)
      : Promise.resolve([]),
    ActivityEventModel.find({ orgId, projectId, type: { $regex: "^project\\." } })
      .select({ userId: 1 })
      .limit(2000)
      .lean() as Promise<Array<{ userId?: unknown }>>,
    // What the confirm will drop: pending mail about this room, or about one of its documents, owed
    // to somebody who will not be in it. Counted here so the dialog can say the number rather than
    // the person discovering it from an email that never came.
    NotificationQueueModel.countDocuments({
      orgId,
      status: "pending",
      userId: { $nin: [...grantedIds, actorUserId].filter(Boolean).map((id) => new Types.ObjectId(id)) },
      // The queue denormalizes the event under `event.*`, so these are `event.projectId` and
      // `event.docId` and not top-level fields.
      $or: [
        { "event.projectId": projectId },
        ...(docIds.length ? [{ "event.docId": { $in: docIds.map((id) => new Types.ObjectId(id)) } }] : []),
      ],
    }),
  ]);

  const keeperIds = new Set<string>();
  const because = new Map<string, LockReviewPerson["because"]>();
  const noteKeeper = (id: string, why: LockReviewPerson["because"]) => {
    if (!id) return;
    if (!keeperIds.has(id)) because.set(id, why);
    keeperIds.add(id);
  };
  // The actor is always in: locking yourself out of the room you are locking is not a state this
  // dialog is allowed to produce, and there is no owner bypass to get back in (decision 21).
  noteKeeper(actorUserId, "you");
  for (const id of grantedIds) noteKeeper(id, "member");
  noteKeeper(idOf(params.project.userId), "creator");
  for (const u of uploaders) noteKeeper(idOf(u.userId), "uploader");
  for (const a of actors) noteKeeper(idOf(a.userId), "acted");

  const orgRoleById = new Map<string, string>();
  for (const m of orgMembers) {
    const id = idOf(m.userId);
    if (id) orgRoleById.set(id, typeof m.role === "string" ? m.role : "");
  }
  // Only live workspace members can be keepers: a grant for somebody who has left the workspace is a
  // row nothing can act on, and the roster would name a person who cannot sign in.
  const keepers = [...keeperIds].filter((id) => orgRoleById.has(id));
  const losing = [...orgRoleById.keys()].filter((id) => !keeperIds.has(id));

  const users = (await UserModel.find({ _id: { $in: [...keepers, ...losing].map((id) => new Types.ObjectId(id)) } })
    .select({ _id: 1, name: 1, email: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; name?: unknown; email?: unknown }>;
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const person = (id: string): LockReviewPerson => {
    const u = userById.get(id);
    return {
      userId: id,
      name: typeof u?.name === "string" && u.name.trim() ? u.name.trim() : null,
      email: typeof u?.email === "string" && u.email.trim() ? u.email.trim().toLowerCase() : null,
      orgRole: orgRoleById.get(id) ?? null,
      ...(because.get(id) ? { because: because.get(id) } : {}),
    };
  };
  const byName = (a: LockReviewPerson, b: LockReviewPerson) =>
    (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "");

  const shareEnabled = params.project.shareEnabled !== false;
  const shareId = typeof params.project.shareId === "string" ? params.project.shareId : "";
  const mappedChannels = slackRows
    .map((r) => (typeof r.channelName === "string" ? r.channelName : ""))
    .filter(Boolean);

  return {
    target: params.target,
    // Nothing to review when the room is empty, has no live link and hides from nobody. The token is
    // still minted, so a client that always sends it is never wrong.
    reviewRequired:
      params.target === "locked"
        ? docIds.length > 0 || liveLinks > 0 || losing.length > 0
        : grantedIds.size > 0 || docIds.length > 0,
    token: createLockReviewToken({
      projectId,
      userId: actorUserId,
      target: params.target,
      ...(typeof params.now === "number" ? { now: params.now } : {}),
    }),
    members: {
      losing: losing.map(person).sort(byName),
      keepers: keepers.map(person).sort(byName),
      current: [...grantedIds].filter((id) => orgRoleById.has(id)).map(person).sort(byName),
      cap: LOCKED_ROOM_MEMBER_CAP,
    },
    docs: { leavingWorkspaceListings: docIds.length, alsoInAnotherRoom },
    links: {
      live: typeof liveLinks === "number" ? liveLinks : 0,
      publicPath: shareEnabled && shareId ? `/p/${shareId}` : null,
      shareEnabled,
    },
    slack: {
      mappedChannels,
      // A locked room never posts to the catch-all (decision 20), so no mapping means silence. That
      // is the correct failure for a room whose point is silence, and the dialog says it out loud.
      postsWillStop: params.target === "locked" && mappedChannels.length === 0,
    },
    notifications: { pendingRowsDropped: typeof pendingRowsDropped === "number" ? pendingRowsDropped : 0 },
  };
}
