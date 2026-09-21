/**
 * `/waitlist` — where a new account waits while we let people in a few at a time.
 *
 * Two jobs, in this order: make the wait feel like an account rather than a rejection, and make
 * the product worth waiting for. So the page is built like the account page they will eventually
 * have — their name, their picture, their place in the queue — with the feature list beside it.
 *
 * The tone is deliberate. Nobody is being kept out for being unworthy; we are early, and a product
 * that mishandles someone's documents on day one has cost them something real. Saying that plainly
 * is more respectful than a countdown or a "you're special" flourish.
 *
 * Reached by the redirect in `src/app/(app)/layout.tsx`; see `src/lib/waitlist/waitlist.ts` for the
 * rules about who lands here at all.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { authOptions } from "@/lib/auth";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import { readWaitlistState } from "@/lib/waitlist/waitlist";
import SignOutLink from "./SignOutLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "You're on the list",
  description: "LinkDrop is letting people in a few at a time while it's early.",
};

/** What is waiting on the other side. Real features, in the order someone would meet them. */
const FEATURES: { title: string; body: string }[] = [
  {
    title: "Send a PDF as a link",
    body: "Upload it, get a link, send it. Whoever you send it to opens it in the browser. No account, no download, no attachment bouncing off a mailbox limit.",
  },
  {
    title: "See who read it",
    body: "Every open is recorded: which pages they spent time on, how long they stayed, whether they came back, and whether they downloaded it.",
  },
  {
    title: "A link per audience",
    body: "One document, many links: one for each investor, client or firm. Every link has its own password, expiry, download rule and its own numbers.",
  },
  {
    title: "Data rooms",
    body: "Group documents into a project and share the whole thing behind a single link. Replace a file and every link keeps working.",
  },
  {
    title: "AI that reads it first",
    body: "Every link opens with a summary and the key points, so the reader knows what they are looking at. Replace a document and AI compare tells you what changed.",
  },
  {
    title: "Built for agents",
    body: "Claude Code, Cursor, Codex, or any MCP client can upload, share, set a password and read the numbers back. No seat, no separate API to learn.",
  },
];

/** "September 18, 2026", or nothing when we have no date to show. */
function longDate(value: Date | null): string {
  if (!value) return "";
  try {
    return value.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export default async function WaitlistPage() {
  const session = await getServerSession(authOptions);
  const userId = typeof session?.user?.id === "string" ? session.user.id : "";
  // Signed out, there is no queue to be in and nothing here to show.
  if (!userId) redirect("/login?next=%2Fwaitlist");

  const state = await readWaitlistState(userId);
  // Let in since the last page load, or never queued at all: the app is theirs, so take them to it
  // rather than showing a queue they are not in.
  if (state.status === "approved") redirect("/");

  const name = (session?.user?.name ?? "").trim();
  const email = (session?.user?.email ?? "").trim();
  const image = (session?.user?.image ?? "").trim();
  const initials = initialsFromNameOrEmail(name || email || "?");

  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Same soft lighting as the other public pages. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />

        <section className="mx-auto w-full max-w-6xl flex-1 px-8 pb-20 pt-12 sm:px-10 md:pt-16 lg:px-12">
          <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] md:gap-14">
            {/* What is happening, and why. */}
            <div className="max-w-xl">
              <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Early access</p>
              <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
                You&rsquo;re on the list.
              </h1>
              {/* No volume claim. The old copy said more people signed up than we planned for, which
                  the panel beside it could disprove at a glance while the queue was small — a page
                  contradicting itself in one viewport, on a product whose whole pitch is figures you
                  can trust. This says the same thing and stays true at any size. */}
              <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
                Your account is made and waiting. We are letting people in a few at a time while it is early,
                rather than everyone at once.
              </p>
              <p className="mt-4 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
                We are early, and the documents people put in here matter: a deck going to an investor, a data room
                going to a buyer. We would rather be sure it all works than be fast about letting you in. It
                won&rsquo;t be long.
              </p>
              <p className="mt-6 max-w-lg text-[13px] leading-6 text-white/45">
                We&rsquo;ll email {email ? <span className="text-white/70">{email}</span> : "you"} the moment your
                account opens. Nothing else: no drip, no newsletter.
              </p>
            </div>

            {/* The account they already have, waiting. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
              <div className="flex items-center gap-3">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={image}
                    alt=""
                    width={44}
                    height={44}
                    className="h-11 w-11 shrink-0 rounded-full object-cover ring-1 ring-white/15"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-white/80 ring-1 ring-white/15">
                    {initials}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold text-white">{name || "Your account"}</div>
                  {email ? <div className="truncate text-[13px] text-white/50">{email}</div> : null}
                </div>
              </div>

              {/* The queue position is gone, and nothing replaces it.
                  "#1 of 1 waiting" is not encouraging, and every honest alternative is either as
                  unflattering, invented (an estimated wait nobody can predict), or meaningless. A
                  number that has to be spun is not worth showing, least of all here. What remains
                  answers the questions somebody actually has: am I in, since when, and what happens
                  next — and it stays true whether one person is waiting or four hundred, where
                  "you are #387" would have been discouraging anyway. */}
              <div className="mt-6 overflow-hidden rounded-xl bg-white/10 p-px">
                <div className="bg-[#0a0a0c] px-4 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Status</div>
                  <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-amber-300/10 px-2.5 py-1 text-[12px] font-semibold text-amber-200 ring-1 ring-amber-300/25">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                    Queued
                  </div>
                  {longDate(state.waitlistedAt) ? (
                    <div className="mt-2 text-[12px] text-white/45">Joined {longDate(state.waitlistedAt)}</div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[13px] leading-6 text-white/55">
                When it opens you start on Free: three shared documents with tracking, unlimited links on each, and
                50 credits for the AI features. No card.
              </div>

              <div className="mt-6 flex items-center justify-between gap-4">
                <span className="text-[13px] text-white/40">Not you?</span>
                <SignOutLink />
              </div>
            </div>
          </div>

          {/* Worth the wait. */}
          <div className="mt-20">
            <h2 className="font-serif text-3xl tracking-tight text-white sm:text-4xl">What you&rsquo;ll walk into</h2>
            <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title}>
                  <h3 className="font-serif text-xl tracking-tight text-white">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/60">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <PublicFooter className="pb-8" />
      </div>
    </main>
  );
}
