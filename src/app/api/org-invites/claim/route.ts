/**
 * API route for `/api/org-invites/claim`.
 *
 * Redeem an invite token into an org membership (auth required).
 *
 * Two things a reader should know before editing: an emailed invite is bound to the address it was
 * sent to (see the recipient check below), and only a signed-in human may redeem one — an API key
 * cannot, the same rule that already applies to sending an invite.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { recordActivity } from "@/lib/activity/log";
import { OrgModel } from "@/lib/models/Org";
import { debugError, debugLog } from "@/lib/debug";
import { membershipChanged, resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { UserModel } from "@/lib/models/User";
import { approveUser } from "@/lib/waitlist/waitlist";
import { accessStatusChanged } from "@/lib/gating/waitlist";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Fold an address down to the mailbox it actually reaches, so a match is decided on delivery and
 * not on spelling.
 *
 * Only the two transformations that are true of the mail system itself, not guesses:
 *
 * - **`+tag` sub-addressing.** Mail to `dana+lnkdrp@corp.com` is delivered to `dana@corp.com`, so
 *   someone invited at a tagged address and signed in at the plain one is the same mailbox. (The
 *   reverse holds too: to hold an account at a tagged address you must be able to read mail at the
 *   base one.)
 * - **Gmail's dot-blindness**, and only for Gmail: `d.ana@gmail.com` and `dana@gmail.com` are one
 *   account there. Everywhere else a dot is a real character and stripping it would merge two
 *   different people, so this is scoped to gmail.com/googlemail.com by name.
 *
 * Anything more aggressive (domain aliases, corporate forwards, "same name, different company")
 * cannot be verified from here and is left to the admin to re-invite — see the refusal below.
 */
function mailbox(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.split(".").join("");
  return `${local}@${domain}`;
}

export async function POST(request: Request) {
  try {
    debugLog(2, "[api/org-invites/claim] POST");
    const actor = await resolveActor(request);
    // Identity-grade: a key may not seat anyone in a workspace, not even its own owner — see
    // forbidApiKey. The minting half (`/api/org-invites/email`) already refuses keys; without the
    // same gate here a leaked `lnk_` key that got hold of an invite URL could still redeem it and
    // hand its owner's account a role — or, with the owner's own key, promote that account past
    // the deliberate "a person clicked Join" step this flow is built around.
    const keyRefusal = forbidApiKey(actor, "redeem a workspace invite");
    if (keyRefusal) return keyRefusal;
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ token: string }>;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

    await connectMongo();

    const tokenHash = sha256Hex(token);
    const invite = await OrgInviteModel.findOne({ tokenHash, isRevoked: { $ne: true } })
      .select({ _id: 1, orgId: 1, role: 1, expiresAt: 1, redeemedAt: 1, recipientEmail: 1 })
      .lean();

    const expiresAt = invite && (invite as unknown as { expiresAt?: unknown }).expiresAt;
    const expired = !(expiresAt instanceof Date) || expiresAt.getTime() <= Date.now();
    const redeemedAt = invite && (invite as unknown as { redeemedAt?: unknown }).redeemedAt;
    const redeemed = redeemedAt instanceof Date;

    if (!invite || expired || redeemed) {
      return NextResponse.json({ error: "Invalid or expired invite" }, { status: 404 });
    }

    const inviteId = (invite as unknown as { _id: Types.ObjectId })._id;
    const orgId = String((invite as unknown as { orgId?: unknown }).orgId ?? "");
    if (!orgId || !Types.ObjectId.isValid(orgId)) {
      return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
    }

    // Personal workspaces are single-user; joining via invite is never allowed.
    const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgId), isDeleted: { $ne: true } })
      .select({ type: 1 })
      .lean();
    const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
    if (orgType !== "team") {
      return NextResponse.json({ error: "Invalid or expired invite" }, { status: 404 });
    }

    const roleRaw = String((invite as unknown as { role?: unknown }).role ?? "member");
    const role = roleRaw === "admin" || roleRaw === "viewer" ? roleRaw : "member";

    // An emailed invite is addressed to someone. Until now it wasn't.
    //
    // `recipientEmail` was written when the invite was sent and shown back in the Teams tab, but
    // nothing ever compared it: this handler selected `_id, orgId, role, expiresAt, redeemedAt`,
    // took the role verbatim and seated whoever happened to be signed in. So the address on an
    // `admin` invite was decoration — forward the mail, quote it in a reply-all, pull it out of a
    // scanned inbox or a shared support mailbox, and the finder became an admin of a workspace
    // that never meant to offer them anything. The token was the whole authorization; the name on
    // the envelope bought nothing.
    //
    // So: if the invite names a recipient, the claimer has to *be* that recipient. Sign-in is
    // Google-only (src/lib/auth.ts), so the account email here is one Google verified, not a
    // self-asserted string — which is what makes this check worth anything.
    //
    // Two deliberate limits on the strictness:
    //
    // - Link invites (`POST /api/org-invites`, no recipient) are unaffected. Those are *meant* to
    //   be bearer capabilities — an admin copies the link and hands it to someone — and there is
    //   no address to bind them to. Nothing here changes for them.
    // - Matching is on the delivered mailbox (`mailbox()` above), not the literal string, so a
    //   `+tag` alias or a dotted Gmail spelling still joins.
    //
    // A mismatch is a refusal, not a "are you sure?" — the only party who could meaningfully
    // confirm that a different address is still the right person is the admin who sent the
    // invite, and they are not in this request. Asking the *claimer* to confirm would hand the
    // decision to exactly the person the check exists to stop. Someone who signed up under
    // another address gets a fresh invite from an admin, which costs one click and leaves a
    // record. The invite is not spent by a refusal: it stays claimable by the right person.
    const invitedEmailRaw = (invite as unknown as { recipientEmail?: unknown }).recipientEmail;
    const invitedEmail = typeof invitedEmailRaw === "string" ? invitedEmailRaw.trim() : "";
    if (invitedEmail) {
      const claimer = (await UserModel.findById(new Types.ObjectId(actor.userId))
        .select({ email: 1 })
        .lean()) as { email?: string | null } | null;
      const claimerEmail = typeof claimer?.email === "string" ? claimer.email.trim() : "";
      // No address on the account is a mismatch too, not a pass: an account we cannot name cannot
      // be shown to be the invited one.
      if (!claimerEmail || mailbox(claimerEmail) !== mailbox(invitedEmail)) {
        debugLog(1, "[api/org-invites/claim] recipient mismatch", { inviteId: String((invite as unknown as { _id: unknown })._id) });
        return NextResponse.json(
          {
            error: "This invite was sent to a different email address. Sign in with the address it was sent to, or ask an admin of the workspace to invite this account.",
            code: "INVITE_EMAIL_MISMATCH",
          },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
    }

    const now = new Date();
    const userId = new Types.ObjectId(actor.userId);
    const orgObjectId = new Types.ObjectId(orgId);

    // Plan limits: redeeming an invite adds a member, so a pre-existing invite must still respect
    // the workspace's collaborator allowance (Free 0, Pro 1). Existing members re-joining are fine.
    const alreadyMember = await OrgMembershipModel.exists({ orgId: orgObjectId, userId, isDeleted: { $ne: true } });
    if (!alreadyMember) {
      const limitCheck = await checkLimit(orgId, "collaborators");
      if (!limitCheck.ok) {
        void recordActivity({
          orgId,
          userId: actor.userId,
          actorKind: "user",
          type: "plan.limit_reached",
          meta: { limit: limitCheck.limit, used: limitCheck.used, max: limitCheck.max, via: "invite_claim" },
          request,
        });
        return planLimitResponse(limitCheck);
      }
    }

    // Claim the token *before* anything is granted with it.
    //
    // This stamp used to be the last write in the handler: the `findOne` at the top decided the
    // invite was unredeemed, the membership was created, the claimer was taken off the waitlist,
    // and only then was `redeemedAt` set. Nothing held the token across that gap, so N concurrent
    // POSTs with the same token all passed the read, all seated a member, and only one of them won
    // the stamp — a token documented as single-use seating several accounts. The `checkLimit` above
    // cleared every sibling too, because it counts memberships and none of theirs had been written
    // yet, so the collaborator allowance (Free 0, Pro `PRO_INCLUDED_COLLABORATORS`) was exceeded
    // without payment, and every one of those accounts was quietly approved off the early-access
    // queue by `approveUser`.
    //
    // The conditional update is the lock. Mongo evaluates `{ _id, redeemedAt: null }` and applies
    // the write atomically, so exactly one racer matches a document and the others match nothing.
    // `matchedCount: 0` means a sibling got there first, which is the same situation as an invite
    // that was already redeemed before this request began — so it gets the same answer.
    //
    // A result that does not report `matchedCount` is treated as a win, not a loss: this guard is
    // here to stop a race, not to start refusing valid invites whenever it cannot read the driver's
    // reply.
    const claim = (await OrgInviteModel.updateOne(
      { _id: inviteId, redeemedAt: null },
      { $set: { redeemedAt: now, redeemedByUserId: userId, updatedDate: now } },
    )) as { matchedCount?: number } | null;
    if (claim && claim.matchedCount === 0) {
      return NextResponse.json({ error: "Invalid or expired invite" }, { status: 404 });
    }

    // Membership for the invited user.
    //
    // Read first, then decide — a blind upsert on `{ orgId, userId }` gets this wrong, because a
    // revoke soft-deletes the membership rather than removing it. The revoked row still matches,
    // so `$setOnInsert` never runs and the role on it is whatever it was before: invite a former
    // admin back as a viewer and they come back an admin. Three cases, three answers:
    //
    // - **No row** — a genuine first join. Insert it with the invite's role.
    // - **A revoked row** — they left and were invited back. The *invite* decides the role now;
    //   the one they used to hold is exactly what must not carry over.
    // - **A live row** — already a member, following the link again. Leave the role alone: an
    //   invite someone re-clicks (or an old one forwarded to them) must never quietly demote or
    //   promote an existing member.
    //
    // Note for whoever edits this: don't set the same path in two update operators (Mongo error
    // code 40), which is what the single upsert here was working around.
    const membership = (await OrgMembershipModel.findOne({ orgId: orgObjectId, userId })
      .select({ _id: 1, isDeleted: 1 })
      .lean()) as { _id: Types.ObjectId; isDeleted?: boolean } | null;

    try {
      if (!membership) {
        await OrgMembershipModel.updateOne(
          { orgId: orgObjectId, userId },
          {
            $setOnInsert: {
              orgId: orgObjectId,
              userId,
              role,
              createdDate: now,
            },
            $set: { isDeleted: false, updatedDate: now },
          },
          { upsert: true },
        );
      } else if (membership.isDeleted) {
        await OrgMembershipModel.updateOne(
          { _id: membership._id },
          { $set: { role, isDeleted: false, updatedDate: now } },
        );
      } else {
        await OrgMembershipModel.updateOne(
          { _id: membership._id },
          { $set: { isDeleted: false, updatedDate: now } },
        );
      }
    } catch (err) {
      // Claiming first means the token is spent before the membership exists. If the membership
      // write is the thing that failed, nobody was seated, and leaving the invite stamped would
      // hand the person a dead link and make an admin cut a new one for a failure that was ours.
      // Put it back. Scoped to `redeemedByUserId: userId` so this can only ever release the claim
      // *this* request made, never one a sibling won in the meantime.
      try {
        await OrgInviteModel.updateOne(
          { _id: inviteId, redeemedByUserId: userId },
          { $set: { redeemedAt: null, redeemedByUserId: null, updatedDate: new Date() } },
        );
      } catch {
        // Best effort — the membership failure is the one worth reporting.
      }
      throw err;
    }

    // Someone an existing workspace invited is not a stranger at the door: claiming a valid invite
    // takes them out of the early-access queue, if they were ever in it. Doing it here rather than
    // at sign-in is what makes it a *vouch* — the token had to be valid first.
    await approveUser({ userId: actor.userId });
    // Accepting an invite is an approval: clear the cached answer so the very next request from
    // this person is allowed, rather than bouncing them for up to 15 seconds after they joined.
    accessStatusChanged(actor.userId);

    // The membership is live from here, so the cached "is this person a member" answer must not be
    // the stale `false` from the moment before they joined (see `membershipChanged`).
    membershipChanged({ orgId, userId: actor.userId });

    // (The invite was already claimed above, before anything was granted with it.)

    // The other half of `member.invited`: an invitation is a hope, this is the arrival. Only when
    // the join is new — an existing member following the link again has not joined anything, and
    // the feed would otherwise announce them every time.
    if (!alreadyMember) {
      const joined = (await UserModel.findById(userId).select({ name: 1, email: 1 }).lean()) as
        | { name?: string | null; email?: string | null }
        | null;
      void recordActivity({
        orgId,
        userId: actor.userId,
        actorKind: "user",
        type: "member.joined",
        meta: {
          role,
          via: "invite",
          name: joined?.name?.trim() || null,
          email: joined?.email?.trim().toLowerCase() || null,
        },
        request,
      });
    }

    return NextResponse.json({ ok: true, orgId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const name = err instanceof Error ? err.name : "UnknownError";
    const code = (err as unknown as { code?: unknown }).code;
    const mongoCode = typeof code === "number" ? code : null;

    debugError(1, "[api/org-invites/claim] POST failed", {
      name,
      message,
      mongoCode,
    });

    const suffix = mongoCode ? ` (mongoCode=${mongoCode})` : "";
    return NextResponse.json({ error: `ORG_INVITE_CLAIM_FAILED: ${message}${suffix}` }, { status: 500 });
  }
}


