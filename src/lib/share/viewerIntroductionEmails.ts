/**
 * What happens, by email, when a reader introduces themselves on a share link.
 *
 * One entry point — `sendViewerIntroductionEmails` — called from the two routes that can receive an
 * introduction (`/api/share/:shareId/landing` for a data room's front page, `/api/share/:shareId/stats`
 * for a document). Both already decide whether the introduction is *news* before calling; this
 * decides who, if anyone, hears about it.
 *
 * Two mails, with different audiences and different reasons:
 *
 * - **To the reader**, a confirmation link. Never a gate (owner, 2026-09-18): the document is open
 *   and stays open. It is bounded by `shouldSendVerifyEmail` so that re-saving the dialog cannot
 *   turn us into a mail source for an address that never asked to hear from us.
 * - **To the workspace**, and only to the members the anonymous view email already reached. If the
 *   "someone opened your document" mail has not gone out yet, it will carry the name by itself and
 *   a second mail is noise; if it has, it is now wrong in an inbox and this is the correction.
 *
 * Best-effort throughout: an introduction is already recorded and propagated by the time this runs,
 * so nothing here may throw into the caller. It returns what it did so the caller can log it.
 */
import { Types } from "mongoose";

import { NotificationEmailCursorModel } from "@/lib/models/NotificationEmailCursor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { debugError } from "@/lib/debug";
import { sendViewerIntroducedEmail, sendViewerVerifyEmail } from "@/lib/email/sendViewerVerifyEmail";
import { viewerEmailVerifyUrl } from "@/lib/share/viewerEmailToken";
import {
  noteVerifyEmailSent,
  ownerNeedsIntroductionEmail,
  recordViewerIntroduction,
  shouldSendVerifyEmail,
} from "@/lib/share/viewerEmailVerification";

export type ViewerIntroductionEmailArgs = {
  orgId: Types.ObjectId | string;
  /** The link they introduced themselves on. */
  shareId: string;
  /** The bare viewer digest — never a project key with its document suffix. */
  viewerKey: string;
  email: string;
  name?: string | null;
  /** What they are reading, for a subject both sides recognise. */
  documentTitle?: string | null;
  /** The workspace's display name, when it has one worth showing a stranger. */
  workspaceName?: string | null;
  /** Where the owner goes to see the reading itself. */
  metricsUrl?: string | null;
  /** When this reader first appeared in the workspace's analytics. */
  viewerFirstSeenAt?: Date | null;
  /** Absolute site base, resolved by the caller. */
  appUrl: string;
  now?: Date;
};

export type ViewerIntroductionEmailResult = {
  verifySent: boolean;
  ownerEmailsSent: number;
};

/**
 * The members who were already told about this reader, anonymously.
 *
 * A member is in scope when view emails are on for them (a missing mode reads as "daily", matching
 * the notification job) and their `share_views` cursor has advanced at or past the moment this
 * reader first appeared — which is precisely what "you have already had a mail that included this
 * person, and it had no name in it" means.
 */
async function membersAlreadyToldAnonymously(params: {
  orgId: Types.ObjectId;
  viewerFirstSeenAt: Date | null;
}): Promise<{ email: string }[]> {
  const { orgId, viewerFirstSeenAt } = params;
  if (!viewerFirstSeenAt) return [];

  const memberships = (await OrgMembershipModel.find({ orgId, isDeleted: { $ne: true } })
    .select({ userId: 1, viewEmailMode: 1 })
    .lean()) as Array<{ userId: Types.ObjectId; viewEmailMode?: string | null }>;

  const wanting = memberships.filter((m) => (m.viewEmailMode ?? "daily") !== "off");
  if (!wanting.length) return [];

  const userIds = wanting.map((m) => m.userId);
  const cursors = (await NotificationEmailCursorModel.find({
    orgId,
    key: "share_views",
    userId: { $in: userIds },
  })
    .select({ userId: 1, lastNotifiedAt: 1 })
    .lean()) as Array<{ userId: Types.ObjectId; lastNotifiedAt?: Date | null }>;

  const notifiedThrough = new Map<string, Date | null>();
  for (const c of cursors) {
    notifiedThrough.set(String(c.userId), c.lastNotifiedAt ? new Date(c.lastNotifiedAt) : null);
  }

  const told = wanting.filter((m) =>
    ownerNeedsIntroductionEmail({
      viewerFirstSeenAt,
      notifiedThroughAt: notifiedThrough.get(String(m.userId)) ?? null,
    }),
  );
  if (!told.length) return [];

  const users = (await UserModel.find({ _id: { $in: told.map((m) => m.userId) }, isActive: { $ne: false } })
    .select({ email: 1 })
    .lean()) as Array<{ email?: string | null }>;

  return users
    .map((u) => (typeof u.email === "string" ? u.email.trim().toLowerCase() : ""))
    .filter((e): e is string => Boolean(e))
    .map((email) => ({ email }));
}

/** Send whatever this introduction warrants. Never throws. */
export async function sendViewerIntroductionEmails(
  args: ViewerIntroductionEmailArgs,
): Promise<ViewerIntroductionEmailResult> {
  const result: ViewerIntroductionEmailResult = { verifySent: false, ownerEmailsSent: 0 };
  const email = (args.email ?? "").trim().toLowerCase();
  if (!email) return result;

  const orgId = typeof args.orgId === "string" ? new Types.ObjectId(args.orgId) : args.orgId;
  const now = args.now ?? new Date();

  let record;
  try {
    record = await recordViewerIntroduction({
      orgId,
      email,
      viewerKey: args.viewerKey,
      shareId: args.shareId,
      now,
    });
  } catch (err) {
    // Without the row we cannot bound the sending, and unbounded mail to a stranger's address is
    // the one outcome worse than no mail at all.
    debugError(1, "[viewerIntroductionEmails] could not record the introduction; sending nothing", err);
    return result;
  }

  if (shouldSendVerifyEmail(record, now)) {
    try {
      await sendViewerVerifyEmail({
        to: email,
        documentTitle: args.documentTitle,
        workspaceName: args.workspaceName,
        verifyUrl: viewerEmailVerifyUrl(args.appUrl, {
          shareId: args.shareId,
          viewerKey: args.viewerKey,
          email,
        }),
      });
      result.verifySent = true;
      // Counted only after a send that did not throw, so a provider outage does not spend the
      // reader's three attempts on mails that never left.
      await noteVerifyEmailSent({ orgId, email, now }).catch(() => {});
    } catch (err) {
      debugError(1, "[viewerIntroductionEmails] confirmation email failed", err);
    }
  }

  try {
    const recipients = await membersAlreadyToldAnonymously({
      orgId,
      viewerFirstSeenAt: args.viewerFirstSeenAt ?? null,
    });
    for (const recipient of recipients) {
      try {
        await sendViewerIntroducedEmail({
          to: recipient.email,
          documentTitle: args.documentTitle,
          viewerName: args.name,
          viewerEmail: email,
          // What we can honestly say *now*. Usually false — they have not clicked yet — and true
          // for a returning contact who confirmed this address on an earlier document.
          verified: record.verified,
          metricsUrl: args.metricsUrl,
        });
        result.ownerEmailsSent += 1;
      } catch (err) {
        debugError(1, "[viewerIntroductionEmails] owner correction email failed", err);
      }
    }
  } catch (err) {
    debugError(1, "[viewerIntroductionEmails] could not work out who to correct", err);
  }

  return result;
}
