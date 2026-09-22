/**
 * API route for `POST /api/waitlist/accept` — record that somebody accepted their invitation.
 *
 * Two credentials, both required, because they prove different things:
 *
 * - **The token** proves the invitation reached that address. It is signed, carries the user id and
 *   an expiry, and is not authentication — invitation mail is forwarded, archived and screenshotted.
 * - **The session** proves who is answering. What this route writes is a record that a person
 *   agreed to the Terms, and "whoever opened this email agreed" is not worth keeping.
 *
 * So the token names an account and the session has to *be* that account. A signed-in visitor
 * holding somebody else's link is refused, and told which address the invitation was for rather
 * than being left at a dead end — the common case there is two Google accounts in one browser, not
 * an attack.
 *
 * **The token is optional; the session is not.** Somebody the entry gate sent here — approved
 * before this flow existed, or who ignored the email and signed in directly — arrives with no
 * token at all, and refusing them would lock them out of their own workspace. That is safe in the
 * direction it looks unsafe: a session proves more than a token does, so requiring one and
 * accepting the other only when it agrees is the stricter rule, not the looser one.
 *
 * Idempotent: accepting twice keeps the first timestamp. Someone who double-taps the button, or
 * comes back to the link later, has not agreed twice and the record should not say they did.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { UserModel } from "@/lib/models/User";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { verifyAcceptToken } from "@/lib/waitlist/acceptToken";
import { approveUser } from "@/lib/waitlist/waitlist";
import { accessStatusChanged, readAccessStatus } from "@/lib/gating/waitlist";
import { CURRENT_TERMS_VERSION } from "@/lib/legal/terms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const session = await tryResolveAuthUserId(request);
    if (!session?.userId) {
      return NextResponse.json({ error: "AUTH_REQUIRED", redirectTo: "/login" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
    const rawToken = typeof body?.token === "string" ? body.token.trim() : "";

    /**
     * Whether an invitation was actually presented, which is a different question from who is
     * asking — and the distinction this route originally got wrong.
     *
     * Two things happen below: the Terms are recorded, and the account is let out of the queue.
     * Only the first is something a person may do for themselves. The second is an admission
     * decision that belongs to an invitation or an admin, and running it on the session alone made
     * `POST /api/waitlist/accept` with an empty body a self-service way off the waitlist for
     * anyone who could sign in with Google.
     */
    let invited = false;

    if (rawToken) {
      const verified = verifyAcceptToken(rawToken);
      if (!verified.ok) {
        // The reason travels so the page can say "this link has expired, ask for another" rather
        // than the same shrug for a forged token and a fortnight-old one.
        return NextResponse.json({ error: "INVALID_TOKEN", reason: verified.reason }, { status: 400 });
      }
      // A token that names somebody else is refused even though the session alone would have been
      // enough: whoever sent that link meant it for a different person, and silently accepting as
      // the signed-in account would record the wrong agreement.
      if (verified.userId !== session.userId) {
        return NextResponse.json({ error: "WRONG_ACCOUNT" }, { status: 403 });
      }
      invited = true;
    }
    if (!Types.ObjectId.isValid(session.userId)) {
      return NextResponse.json({ error: "INVALID_TOKEN", reason: "malformed" }, { status: 400 });
    }

    await connectMongo();
    const _id = new Types.ObjectId(session.userId);

    /**
     * Accepting is also how somebody invited while still queued leaves the queue — but *only* on
     * the strength of the invitation. Without a verified token this route records the Terms and
     * nothing else.
     *
     * A still-queued account with no token has no business here at all: the entry gate checks the
     * queue before the Terms (`entryGate.ts`), so it sends a waitlisted person to `/waitlist`, never
     * here. Reaching this line in that state means the request came from somewhere other than the
     * flow, and the honest answer is the one the gate would have given.
     */
    if (!invited && (await readAccessStatus(session.userId)) === "waitlisted") {
      return NextResponse.json(
        { error: "WAITLISTED", redirectTo: "/waitlist", message: "Your account is still on the early-access waitlist." },
        { status: 403 },
      );
    }

    if (invited) {
      // `approveUser`'s filter carries the condition, so this is a no-op for an account already
      // approved rather than a second approval.
      const approval = await approveUser({ userId: session.userId });
      if (!approval.ok) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
      if (approval.changed) accessStatusChanged(session.userId);
    }

    // `termsAcceptedAt: null` in the filter is what makes this idempotent: the second POST matches
    // nothing and the original timestamp stands.
    const updated = await UserModel.findOneAndUpdate(
      { _id, termsAcceptedAt: null },
      { $set: { termsAcceptedAt: new Date(), termsVersion: CURRENT_TERMS_VERSION } },
      { new: true },
    )
      .select({ termsAcceptedAt: 1, termsVersion: 1 })
      .lean();

    const already = !updated;
    const row = (updated ??
      ((await UserModel.findById(_id).select({ termsAcceptedAt: 1, termsVersion: 1 }).lean()) as {
        termsAcceptedAt?: Date | null;
        termsVersion?: string | null;
      } | null)) as { termsAcceptedAt?: Date | null; termsVersion?: string | null } | null;

    return NextResponse.json(
      {
        ok: true,
        already,
        acceptedAt: row?.termsAcceptedAt ? new Date(row.termsAcceptedAt).toISOString() : null,
        termsVersion: row?.termsVersion ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
