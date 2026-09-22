/**
 * `/accept` — where an invitation is accepted, and with it the Terms.
 *
 * Reached from the link in the invitation email. Everything that decides *what this person sees* is
 * here, on the server, so the client component below it only has a button and a state machine:
 *
 * - **No token at all, but signed in** — show them the acceptance anyway. This is how the entry
 *   gate sends somebody who was approved before the flow existed, or who ignored the email and
 *   signed in directly, and a dead end there would lock them out of their own workspace. A session
 *   is a stronger credential than the token, not a weaker one: the token exists to name an account
 *   for somebody arriving from mail, and a signed-in visitor has already been named.
 * - **A broken token** — say so plainly and stop. Something was meant to be here.
 * - **Not signed in** — send them to sign in and come straight back. The token names an account;
 *   only a session can prove somebody *is* it, and a Terms record that says "whoever held this
 *   link agreed" is not worth writing.
 * - **Signed in as somebody else** — the common cause is two Google accounts in one browser, so it
 *   names the address the invitation was for instead of a flat refusal.
 * - **Already accepted** — no second prompt; they are simply in.
 *
 * The page is `noindex`: it exists only at the end of a link somebody was sent.
 *
 * It wears the same lit dark ground as `/waitlist`, which is where this person was an hour ago.
 * Landing on the app's neutral shell after that reads as a different product, and it is the one
 * screen where they are being asked to agree to something.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { Types } from "mongoose";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { authOptions } from "@/lib/auth";
import { FREE_DOCUMENTS } from "@/lib/billing/planLimits";
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { verifyAcceptToken } from "@/lib/waitlist/acceptToken";
import AcceptClient from "./AcceptClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accept your invitation",
  robots: { index: false, follow: false },
};

/** A message and nothing to do, for every state that is not "accept this". */
function DeadEnd({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-xl">
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Early access</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">{title}</h1>
      <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">{body}</p>
      <Link
        href="/"
        className="mt-8 inline-block text-[14px] text-white/45 underline-offset-4 transition-colors hover:text-white hover:underline"
      >
        Go to LinkDrop
      </Link>
    </div>
  );
}

export default async function AcceptPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)?.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  const session = await getServerSession(authOptions);
  const signedInUserId = typeof session?.user?.id === "string" ? session.user.id : "";

  // No token and a session: the entry gate sent them. Accept as themselves.
  const verified = token ? verifyAcceptToken(token) : ({ ok: true, userId: signedInUserId } as const);

  const shell = (children: React.ReactNode) => (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* The same soft lighting as `/waitlist` and the other public pages. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />
      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader admitted={false} />
        <section className="mx-auto w-full max-w-6xl px-8 pb-16 pt-12 sm:px-10 md:pt-16 lg:px-12">
          {children}
        </section>
        <PublicFooter className="pb-8" />
      </div>
    </main>
  );

  if (!verified.ok) {
    if (verified.reason === "expired") {
      return shell(
        <DeadEnd
          title="This invitation has expired."
          body="Invitation links last two weeks. Reply to the email that brought you here and we will send a fresh one."
        />,
      );
    }
    return shell(
      <DeadEnd
        title="This link isn't valid."
        body="It may have been copied incompletely, or it was never an invitation link. The one in your email is the one that works."
      />,
    );
  }

  if (!signedInUserId) {
    // Straight back here with the token intact, so signing in costs them nothing but a click.
    const next = token ? `/accept?token=${encodeURIComponent(token)}` : "/accept";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  if (!Types.ObjectId.isValid(verified.userId)) {
    return shell(<DeadEnd title="This link isn't valid." body="The account it points at no longer exists." />);
  }

  await connectMongo();
  const invited = (await UserModel.findById(new Types.ObjectId(verified.userId))
    .select({ email: 1, name: 1, termsAcceptedAt: 1 })
    .lean()) as { email?: string | null; name?: string | null; termsAcceptedAt?: Date | null } | null;

  if (!invited) {
    return shell(<DeadEnd title="This link isn't valid." body="The account it points at no longer exists." />);
  }

  if (signedInUserId !== verified.userId) {
    const invitedEmail = (invited.email ?? "").trim();
    return shell(
      <DeadEnd
        title="This invitation is for a different account."
        body={
          invitedEmail
            ? `It was sent to ${invitedEmail}. Sign out and sign back in with that account, then open the link again.`
            : "Sign out and sign back in with the account the invitation was sent to, then open the link again."
        }
      />,
    );
  }

  if (invited.termsAcceptedAt) {
    return shell(
      <DeadEnd
        title="You're already in."
        body="You accepted this invitation, so there is nothing left to do here."
      />,
    );
  }

  const name = (invited.name ?? "").trim();
  const email = (invited.email ?? "").trim();
  const first = name.split(/\s+/)[0] ?? "";
  // The picture comes from the session rather than the row: it is the same person either way, and
  // only the session has it.
  const image = (session?.user?.image ?? "").trim();

  return shell(
    <AcceptClient
      token={token}
      firstName={first}
      name={name}
      email={email}
      image={image}
      initials={initialsFromNameOrEmail(name || email || "?")}
      freeDocuments={FREE_DOCUMENTS}
      freeCredits={FREE_STARTER_CREDITS}
    />,
  );
}
