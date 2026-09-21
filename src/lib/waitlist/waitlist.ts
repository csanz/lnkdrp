/**
 * The early-access queue.
 *
 * We let people in a few at a time while the product is young. Everything about that decision is
 * here: whether the queue is on, who skips it, where a new account starts, and how someone is let
 * in. The rules the rest of the app must not have to re-derive:
 *
 * - **The queue is off unless `WAITLIST_ENABLED` says otherwise.** Off is the honest default: a
 *   flag that gates sign-ups should be something you turn on deliberately, not something a missing
 *   env var does to you.
 * - **It only ever applies to accounts created while it is on.** Status is written once, at
 *   sign-up, into `$setOnInsert`. Nobody already using the product is affected by turning it on,
 *   and a user row with no status reads as approved.
 * - **Being invited skips the queue.** Someone an existing workspace vouched for is not a stranger
 *   at the door; `POST /api/org-invites/claim` approves them as it adds them.
 * - **Admins and the allowlist skip it too**, so the people running the thing can always get in.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";

export type AccessStatus = "approved" | "waitlisted";

/** Is the queue on? `WAITLIST_ENABLED=1|true|on|yes`; anything else, including unset, is off. */
export function waitlistEnabled(): boolean {
  const raw = (process.env.WAITLIST_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Addresses and domains that never queue: `WAITLIST_ALLOW_EMAILS`, `WAITLIST_ALLOW_DOMAINS`. */
function allowList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[,\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** True when this address is let straight in, queue or no queue. */
export function isAllowlistedEmail(email: string | null | undefined): boolean {
  const address = (email ?? "").trim().toLowerCase();
  if (!address) return false;
  if (allowList("WAITLIST_ALLOW_EMAILS").includes(address)) return true;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return Boolean(domain) && allowList("WAITLIST_ALLOW_DOMAINS").includes(domain);
}

/** Where a brand-new account starts. Existing accounts never pass through here. */
export function initialAccessStatus(email: string | null | undefined): AccessStatus {
  if (!waitlistEnabled()) return "approved";
  return isAllowlistedEmail(email) ? "approved" : "waitlisted";
}

/** A user row's status, with the missing-field and disabled-queue cases folded in. */
export function accessStatusOf(user: { accessStatus?: unknown; role?: unknown } | null | undefined): AccessStatus {
  if (!user) return "approved";
  // An admin is never held at the door — including one created while the queue was on.
  if (user.role === "admin") return "approved";
  return user.accessStatus === "waitlisted" ? "waitlisted" : "approved";
}

export type WaitlistState = {
  status: AccessStatus;
  waitlistedAt: Date | null;
};

/**
 * What to tell one person about the queue: whether they are in it, and since when.
 *
 * It used to also return their place and the size of the queue, and `/waitlist` printed both. That
 * was removed rather than hidden. "#1 of 1 waiting" is not encouraging, and it sat beside copy
 * claiming more signups than expected — a page disproving itself in a single viewport, on a
 * product whose whole pitch is figures you can trust. Every honest alternative was as unflattering,
 * invented, or meaningless, and at the other end "you are #387" is discouraging too. There is no
 * size of queue at which the number helps.
 *
 * So the two `countDocuments` calls behind it are gone as well; a field nobody renders is not worth
 * a scan of the users collection on every page load. Bring them back the day there is a question
 * they answer.
 */
export async function readWaitlistState(userId: string): Promise<WaitlistState> {
  if (!Types.ObjectId.isValid(userId)) return { status: "approved", waitlistedAt: null };
  await connectMongo();

  const user = (await UserModel.findById(new Types.ObjectId(userId))
    .select({ accessStatus: 1, waitlistedAt: 1, role: 1 })
    .lean()) as { accessStatus?: unknown; waitlistedAt?: Date | null; role?: unknown } | null;

  const status = accessStatusOf(user);
  if (status === "approved") return { status, waitlistedAt: null };
  return { status, waitlistedAt: user?.waitlistedAt instanceof Date ? user.waitlistedAt : null };
}

/**
 * Let someone in.
 *
 * Idempotent, and it reports whether this call is the one that did it — the welcome email hangs off
 * that, and clicking Approve twice must not email them twice.
 */
export async function approveUser(params: {
  userId: string;
  approvedByUserId?: string | null;
}): Promise<{ ok: boolean; changed: boolean; email: string | null; name: string | null }> {
  if (!Types.ObjectId.isValid(params.userId)) return { ok: false, changed: false, email: null, name: null };
  await connectMongo();

  const now = new Date();
  const approvedBy =
    params.approvedByUserId && Types.ObjectId.isValid(params.approvedByUserId)
      ? new Types.ObjectId(params.approvedByUserId)
      : null;

  // The filter carries the condition: only a row that is still waiting is changed, so two clicks
  // (or two admins) produce one approval and one email.
  const changed = await UserModel.findOneAndUpdate(
    { _id: new Types.ObjectId(params.userId), accessStatus: "waitlisted" },
    { $set: { accessStatus: "approved", approvedAt: now, approvedByUserId: approvedBy } },
    { new: true },
  )
    .select({ email: 1, name: 1 })
    .lean();

  if (changed) {
    const row = changed as { email?: unknown; name?: unknown };
    return {
      ok: true,
      changed: true,
      email: typeof row.email === "string" ? row.email : null,
      name: typeof row.name === "string" ? row.name : null,
    };
  }

  const existing = (await UserModel.findById(new Types.ObjectId(params.userId))
    .select({ email: 1, name: 1 })
    .lean()) as { email?: unknown; name?: unknown } | null;
  if (!existing) return { ok: false, changed: false, email: null, name: null };
  return {
    ok: true,
    changed: false,
    email: typeof existing.email === "string" ? existing.email : null,
    name: typeof existing.name === "string" ? existing.name : null,
  };
}
