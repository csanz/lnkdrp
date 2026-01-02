/**
 * API route: POST `/api/invites/request`
 *
 * Creates an invite request (email + description) for admins to approve.
 * If the email already has an account, or already has an existing request/invite, we avoid creating duplicates.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}
/**
 * Normalize Email (uses toLowerCase, trim).
 */


function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
/**
 * Handle POST requests.
 */

type InviteRequestResultKind = "created" | "already_requested" | "already_invited" | "already_has_account";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown;

    const rawEmail = asNonEmptyString((body as { email?: unknown }).email);
    const description = asNonEmptyString((body as { description?: unknown }).description);
    if (!rawEmail) return NextResponse.json({ error: "Missing email" }, { status: 400 });
    if (!description) return NextResponse.json({ error: "Missing description" }, { status: 400 });

    const email = normalizeEmail(rawEmail);

    await connectMongo();

    // If the user already has an account, they don't need an invite request.
    // (Temp users have no email, so this only matches real users.)
    const existingUser = await UserModel.findOne({ email }).select({ _id: 1 }).lean();
    if (existingUser) {
      return NextResponse.json({ ok: true, kind: "already_has_account" satisfies InviteRequestResultKind });
    }

    // If we've already emailed an invite code for this email (approved request), don't create a new request.
    const existingApproved = await InviteModel.findOne({
      kind: "request",
      requestEmail: email,
      approvedDate: { $ne: null },
      approvalEmailSentDate: { $ne: null },
      approvedInviteCode: { $ne: null },
    })
      .sort({ approvedDate: -1 })
      .select({ _id: 1 })
      .lean();
    if (existingApproved) {
      return NextResponse.json({ ok: true, kind: "already_invited" satisfies InviteRequestResultKind });
    }

    // If there's already a pending request for this email, don't create duplicates.
    const existingPending = await InviteModel.findOne({
      kind: "request",
      requestEmail: email,
      approvedDate: null,
    })
      .select({ _id: 1 })
      .lean();
    if (existingPending) {
      return NextResponse.json({ ok: true, kind: "already_requested" satisfies InviteRequestResultKind });
    }

    await InviteModel.create({
      kind: "request",
      requestEmail: email,
      requestDescription: description,
      isActive: true,
    });

    return NextResponse.json({ ok: true, kind: "created" satisfies InviteRequestResultKind });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


