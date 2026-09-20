/**
 * The bookkeeping behind "yes, that address is mine" on a share link.
 *
 * Three things live here: the row that remembers an address a reader volunteered to a workspace,
 * the rule for how often we are willing to mail that address, and the rule for whether the sender
 * needs to be told about the introduction at all.
 *
 * None of it is on the reading path. Confirming is explicitly not a gate (owner, 2026-09-18) — the
 * document is already open, and a confirmation only upgrades a *claimed* address to a *verified*
 * one so the sender knows which of the two they are looking at.
 */
import { Types } from "mongoose";

import { ShareViewerEmailModel } from "@/lib/models/ShareViewerEmail";

/**
 * How willing we are to mail an address that has not confirmed yet.
 *
 * A reader can re-open the "Introduce yourself" dialog and press Save as often as they like, and
 * each Save is a fresh introduction as far as the routes are concerned. Without a bound, a reader
 * idly correcting a typo three times is three emails, and a script holding the link is unbounded
 * mail to an address its owner never gave us — the exact shape of being a spam source. Two bounds,
 * because they stop different things: the interval stops a burst, the cap stops a slow drip.
 */
export const VERIFY_EMAIL_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const VERIFY_EMAIL_MAX_PER_ADDRESS = 3;

export type IntroductionRecord = {
  /** Nobody in this workspace had this address before. */
  firstIntroduction: boolean;
  /** They have already clicked the link in an earlier confirmation mail. */
  verified: boolean;
  /** How many confirmation mails this address has had from this workspace, before this one. */
  verifyEmailsSent: number;
  lastVerifyEmailAt: Date | null;
};

/**
 * Whether a confirmation mail is warranted for an address in this state.
 *
 * Pure, so the rule can be read and tested without a database: a verified address never needs
 * another, a burst is collapsed by the interval, and a reader who has ignored three of them is
 * telling us something we should hear.
 */
export function shouldSendVerifyEmail(
  record: Pick<IntroductionRecord, "verified" | "verifyEmailsSent" | "lastVerifyEmailAt">,
  now: Date = new Date(),
): boolean {
  if (record.verified) return false;
  if (record.verifyEmailsSent >= VERIFY_EMAIL_MAX_PER_ADDRESS) return false;
  const last = record.lastVerifyEmailAt ? record.lastVerifyEmailAt.getTime() : 0;
  if (last && now.getTime() - last < VERIFY_EMAIL_MIN_INTERVAL_MS) return false;
  return true;
}

/**
 * `ownerNeedsIntroductionEmail` used to live here: a heuristic that decided whether the owner had
 * already been sent an anonymous "someone opened your document" mail about a reader, by comparing
 * a member's `share_views` cursor against that reader's first view — and guarding against a cursor
 * created *after* them, which is evidence of nothing.
 *
 * Deleted with the notification queue (docs/prds/lnkdrp-notification-queue.md). Every line of it
 * existed to squeeze an answer out of a high-water mark; the queue records which reader each member
 * was actually told about, so `sentNotificationsForViewer()` is the answer rather than an inference
 * about it. Keeping the heuristic on top of a record would have been strictly worse, and would have
 * looked deliberate to whoever read it next.
 */


/**
 * Remember that this address was volunteered here, and report what we knew about it before.
 *
 * The read-before-write is the point: the caller needs the state *prior* to this introduction to
 * decide whether to mail, and an upsert alone cannot tell it apart from the tenth Save in a row.
 */
export async function recordViewerIntroduction(params: {
  orgId: Types.ObjectId | string;
  email: string;
  viewerKey?: string | null;
  shareId?: string | null;
  now?: Date;
}): Promise<IntroductionRecord> {
  const orgId = typeof params.orgId === "string" ? new Types.ObjectId(params.orgId) : params.orgId;
  const email = params.email.trim().toLowerCase();
  const now = params.now ?? new Date();

  const prior = (await ShareViewerEmailModel.findOne({ orgId, email })
    .select({ verifiedAt: 1, verifyEmailsSent: 1, lastVerifyEmailAt: 1 })
    .lean()) as { verifiedAt?: Date | null; verifyEmailsSent?: number; lastVerifyEmailAt?: Date | null } | null;

  await ShareViewerEmailModel.updateOne(
    { orgId, email },
    {
      $setOnInsert: {
        orgId,
        email,
        firstIntroducedAt: now,
        // The first link they introduced themselves on, not the latest: it answers "where did this
        // contact come from", which a later link would overwrite.
        shareId: params.shareId ?? null,
        viewerKey: params.viewerKey ?? null,
      },
      $set: { updatedDate: now },
    },
    { upsert: true },
  ).catch((e: unknown) => {
    // Two tabs introducing at once race the unique index; the loser's row already exists.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/E11000|duplicate key/i.test(msg)) throw e;
  });

  return {
    firstIntroduction: !prior,
    verified: Boolean(prior?.verifiedAt),
    verifyEmailsSent: typeof prior?.verifyEmailsSent === "number" ? prior.verifyEmailsSent : 0,
    lastVerifyEmailAt: prior?.lastVerifyEmailAt ? new Date(prior.lastVerifyEmailAt) : null,
  };
}

/** Count a confirmation mail we actually sent, so the bounds above mean something. */
export async function noteVerifyEmailSent(params: {
  orgId: Types.ObjectId | string;
  email: string;
  now?: Date;
}): Promise<void> {
  const orgId = typeof params.orgId === "string" ? new Types.ObjectId(params.orgId) : params.orgId;
  await ShareViewerEmailModel.updateOne(
    { orgId, email: params.email.trim().toLowerCase() },
    { $inc: { verifyEmailsSent: 1 }, $set: { lastVerifyEmailAt: params.now ?? new Date() } },
  );
}

/**
 * Mark an address confirmed. Returns whether this click was the one that did it.
 *
 * The `verifiedAt: null` guard makes a second click a no-op rather than a second confirmation, so
 * a reader who opens the mail twice — or a mail client that prefetches the link — does not put two
 * rows in the owner's feed.
 */
export async function markViewerEmailVerified(params: {
  orgId: Types.ObjectId | string;
  email: string;
  viewerKey?: string | null;
  now?: Date;
}): Promise<{ newlyVerified: boolean }> {
  const orgId = typeof params.orgId === "string" ? new Types.ObjectId(params.orgId) : params.orgId;
  const email = params.email.trim().toLowerCase();
  const now = params.now ?? new Date();

  const res = await ShareViewerEmailModel.updateOne(
    { orgId, email, $or: [{ verifiedAt: null }, { verifiedAt: { $exists: false } }] },
    {
      $setOnInsert: { orgId, email, firstIntroducedAt: now, viewerKey: params.viewerKey ?? null },
      $set: { verifiedAt: now, updatedDate: now },
    },
    { upsert: true },
  ).catch((e: unknown) => {
    // The row exists and is already verified: the filter matched nothing and the upsert raced.
    const msg = e instanceof Error ? e.message : String(e);
    if (/E11000|duplicate key/i.test(msg)) return null;
    throw e;
  });

  const modified = (res as { modifiedCount?: number; upsertedCount?: number } | null) ?? null;
  return { newlyVerified: Boolean(modified?.modifiedCount || modified?.upsertedCount) };
}

/** Has this workspace had a confirmed click for this address? */
export async function isViewerEmailVerified(orgId: Types.ObjectId | string, email: string): Promise<boolean> {
  const id = typeof orgId === "string" ? new Types.ObjectId(orgId) : orgId;
  const row = (await ShareViewerEmailModel.findOne({ orgId: id, email: email.trim().toLowerCase() })
    .select({ verifiedAt: 1 })
    .lean()) as { verifiedAt?: Date | null } | null;
  return Boolean(row?.verifiedAt);
}
