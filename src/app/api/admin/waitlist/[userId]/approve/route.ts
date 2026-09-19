/**
 * API route for `POST /api/admin/waitlist/:userId/approve` — let one person in.
 *
 * Admin only. Two things happen, in this order and only this order: the account is opened, then
 * they are told. The email is best-effort and never awaited into the response — an account that is
 * open but whose welcome bounced is a person who can use the product; a failed approval because a
 * mail provider was down is not.
 *
 * `approveUser` only reports `changed` when this call is the one that flipped the row, which is
 * what keeps a double click (or two admins on the same row) from sending two welcomes.
 */
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/gating/requireAdmin";
import { approveUser } from "@/lib/waitlist/waitlist";
import { sendWaitlistApprovedEmail } from "@/lib/email/sendWaitlistApprovedEmail";
import { debugError } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ userId: string }> }) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const { userId: raw } = await ctx.params;
  const userId = (raw ?? "").trim();
  if (!userId) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  const result = await approveUser({ userId, approvedByUserId: gate.userId });
  if (!result.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let emailed = false;
  if (result.changed && result.email) {
    emailed = true;
    void (async () => {
      try {
        await sendWaitlistApprovedEmail({ to: result.email as string, name: result.name });
      } catch (err) {
        debugError(1, "[api/admin/waitlist/approve] welcome email failed", err);
      }
    })();
  }

  return NextResponse.json({ ok: true, changed: result.changed, emailed, userId });
}
