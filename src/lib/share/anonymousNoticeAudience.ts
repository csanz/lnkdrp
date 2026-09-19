/**
 * "Which members have already been emailed about this reader, without a name attached?"
 *
 * One question, one file, deliberately. It is the only thing the viewer-introduction emails need to
 * know about the notification system, and the notification system is being replaced: the per-member
 * cursor scan is becoming a Mongo-backed queue with retries, where a row records *what* was sent
 * rather than only a high-water mark. When that lands, this file is swapped and nothing else moves.
 *
 * The rule that consumes this answer (`ownerNeedsIntroductionEmail`) stays pure and stays where it
 * is; this is only the lookup that feeds it.
 */
import { Types } from "mongoose";

import { NotificationEmailCursorModel } from "@/lib/models/NotificationEmailCursor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { ownerNeedsIntroductionEmail } from "@/lib/share/viewerEmailVerification";

/**
 * A horizon this question has, under either implementation, and which the caller should not fight.
 *
 * The queue keeps sent rows for 30 days. Past that the honest answer to "was a nameless email
 * already sent about this person" becomes "we no longer know", and the lookup returns nobody — so
 * a reader who is seen today and introduces themselves next quarter gets no correction sent on
 * their behalf.
 *
 * That is the right outcome rather than a gap to paper over. The correction exists because a wrong
 * email is sitting unread-as-wrong in an inbox; an inbox from three months ago is not somewhere a
 * correction usefully lands, and "that anonymous reader in July was Dana" is noise by the time it
 * arrives. If this ever needs a permanent answer, it wants its own record written at send time,
 * not a longer TTL on someone else's collection.
 */
export type AlreadyToldQuery = {
  orgId: Types.ObjectId;
  /** When this reader first appeared in the workspace's analytics. */
  viewerFirstSeenAt: Date | null;
};

/** Who to correct: the addresses of members who were told about this reader anonymously. */
export type AlreadyToldLookup = (query: AlreadyToldQuery) => Promise<{ email: string }[]>;

/**
 * The cursor-backed implementation, which is an *inference* rather than a record.
 *
 * A `share_views` cursor is a high-water mark: it says how far a member's notifications have run,
 * not which readers were in them. Two facts have to line up before it is evidence about a
 * particular person — the cursor has to have advanced past them, and it has to have existed before
 * they arrived, because a cursor created later covers nothing behind it (there is no backfill).
 * See `ownerNeedsIntroductionEmail` for why the second half matters.
 *
 * The queue-backed replacement will answer this exactly instead of inferring it.
 */
export const cursorBackedAlreadyTold: AlreadyToldLookup = async ({ orgId, viewerFirstSeenAt }) => {
  if (!viewerFirstSeenAt) return [];

  const memberships = (await OrgMembershipModel.find({ orgId, isDeleted: { $ne: true } })
    .select({ userId: 1, viewEmailMode: 1 })
    .lean()) as Array<{ userId: Types.ObjectId; viewEmailMode?: string | null }>;

  // A missing mode reads as "daily", matching the notification job's own default.
  const wanting = memberships.filter((m) => (m.viewEmailMode ?? "daily") !== "off");
  if (!wanting.length) return [];

  const cursors = (await NotificationEmailCursorModel.find({
    orgId,
    key: "share_views",
    userId: { $in: wanting.map((m) => m.userId) },
  })
    .select({ userId: 1, lastNotifiedAt: 1, createdDate: 1 })
    .lean()) as Array<{ userId: Types.ObjectId; lastNotifiedAt?: Date | null; createdDate?: Date | null }>;

  const cursorByUser = new Map<string, { notifiedThroughAt: Date | null; createdAt: Date | null }>();
  for (const c of cursors) {
    cursorByUser.set(String(c.userId), {
      notifiedThroughAt: c.lastNotifiedAt ? new Date(c.lastNotifiedAt) : null,
      createdAt: c.createdDate ? new Date(c.createdDate) : null,
    });
  }

  const told = wanting.filter((m) => {
    const cursor = cursorByUser.get(String(m.userId));
    return ownerNeedsIntroductionEmail({
      viewerFirstSeenAt,
      notifiedThroughAt: cursor?.notifiedThroughAt ?? null,
      cursorCreatedAt: cursor?.createdAt ?? null,
    });
  });
  if (!told.length) return [];

  const users = (await UserModel.find({ _id: { $in: told.map((m) => m.userId) }, isActive: { $ne: false } })
    .select({ email: 1 })
    .lean()) as Array<{ email?: string | null }>;

  return users
    .map((u) => (typeof u.email === "string" ? u.email.trim().toLowerCase() : ""))
    .filter((e): e is string => Boolean(e))
    .map((email) => ({ email }));
};
