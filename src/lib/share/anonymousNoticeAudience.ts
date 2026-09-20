/**
 * "Which members have already been emailed about this reader, without a name attached?"
 *
 * One question, one file, deliberately — and the swap this file was written to anticipate has now
 * happened. The per-member cursor scan is gone: `NotificationEmailCursor` is no longer written by
 * anything (docs/prds/lnkdrp-notification-queue.md, decision 7), so the old implementation here
 * read timestamps that will never advance again and answered "nobody" for every reader forever,
 * which silently switched the correction email off for the whole product.
 *
 * The queue answers it exactly instead of inferring it: a `share_views` row records *which reader*
 * a given member was told about, and only a `sent` row counts (decision 9).
 */
import { Types } from "mongoose";

import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { sentNotificationsForViewer } from "@/lib/notifications/queue";

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
  /**
   * The reader themselves — the bare viewer digest, or a project link's `<digest>.<docId>`
   * composite, which the queue normalises either way.
   *
   * Optional only so the in-flight caller keeps compiling; the answer is exact with it and empty
   * without it, so it is the field that matters.
   */
  viewerKey?: string | null;
  /**
   * When this reader first appeared in the workspace's analytics.
   *
   * No longer consulted: it existed to make a high-water mark say something about one person, and
   * the queue records the person. Kept on the query because the caller passes it and because the
   * horizon above is still real — a send older than the queue's 30-day retention is invisible here
   * whatever this says.
   */
  viewerFirstSeenAt: Date | null;
};

/** Who to correct: the addresses of members who were told about this reader anonymously. */
export type AlreadyToldLookup = (query: AlreadyToldQuery) => Promise<{ email: string }[]>;

/**
 * The queue-backed implementation: a record, not an inference.
 *
 * `sentNotificationsForViewer` returns the members a `share_views` email covering **this reader**
 * actually reached, and when. That is the whole question, so there is no cursor arithmetic left:
 * no high-water mark to compare against, and no "did the cursor exist before they arrived?" second
 * half to get wrong.
 *
 * Without a viewer key there is no exact answer and this returns nobody. Deliberately: the
 * alternative is the inference this replaced — "they were emailed about *something* after this
 * reader showed up" — and the cost of getting that wrong is a correction email about a mail that
 * was never sent, to someone who was never confused.
 *
 * A member on `off` is filtered out before the queue is asked, because their rows are `skipped`
 * rather than `sent` and a correction to someone who hears nothing is noise.
 */
export const queueBackedAlreadyTold: AlreadyToldLookup = async ({ orgId, viewerKey }) => {
  const key = (viewerKey ?? "").trim();
  if (!key) return [];

  const told = await sentNotificationsForViewer({ orgId, viewerKey: key });
  if (!told.length) return [];

  const memberships = (await OrgMembershipModel.find({
    orgId,
    isDeleted: { $ne: true },
    userId: { $in: told.map((t) => new Types.ObjectId(t.userId)) },
  })
    .select({ userId: 1, viewEmailMode: 1 })
    .lean()) as Array<{ userId: Types.ObjectId; viewEmailMode?: string | null }>;

  // A missing mode reads as "daily", matching the notification job's own default.
  const wanting = memberships.filter((m) => (m.viewEmailMode ?? "daily") !== "off");
  if (!wanting.length) return [];

  const users = (await UserModel.find({ _id: { $in: wanting.map((m) => m.userId) }, isActive: { $ne: false } })
    .select({ email: 1 })
    .lean()) as Array<{ email?: string | null }>;

  return users
    .map((u) => (typeof u.email === "string" ? u.email.trim().toLowerCase() : ""))
    .filter((e): e is string => Boolean(e))
    .map((email) => ({ email }));
};

/**
 * @deprecated The name, not the behaviour: nothing writes `NotificationEmailCursor` any more, so
 * this is the queue-backed lookup. Kept because `viewerIntroductionEmails.ts` imports it by name;
 * that import should move to `queueBackedAlreadyTold` and pass the reader's `viewerKey`, which it
 * already holds — until it does, this answers nobody (see the note on `viewerKey` below).
 */
export const cursorBackedAlreadyTold: AlreadyToldLookup = queueBackedAlreadyTold;
