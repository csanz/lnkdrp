/**
 * Page for `/share/verify?t=<token>` — the link in the reader's confirmation email.
 *
 * A server component on purpose: the whole job is done before anything renders, so a reader who
 * clicks from their inbox sees the answer rather than a spinner that resolves into one.
 *
 * Two things it deliberately does *not* do:
 *
 * - **It does not check whether the link still opens.** Confirming an address is not reading a
 *   document. A deck whose link expired last night, or was disabled after it was sent, must still
 *   let the reader say "that was me" — the owner wants the name on the reading that already
 *   happened. So the slug is resolved only to find the workspace, and `refusal` is ignored.
 * - **It does not gate anything.** Nothing about the reading path changes whether this is clicked
 *   or not (owner, 2026-09-18). The gated variant is a separate feature (metis mt_Ef6isZoEr5).
 *
 * Known and accepted: some mail clients and security scanners fetch links in a message before a
 * person sees it, which would mark an address confirmed without a human click. That is a property
 * of every one-click confirmation link, and the thing being claimed here — "this address received
 * our email" — is still true when a scanner is the one that fetched it.
 */
import Link from "next/link";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { markViewerEmailVerified } from "@/lib/share/viewerEmailVerification";
import { verifyViewerEmailToken } from "@/lib/share/viewerEmailToken";
import { resolveShareLink } from "@/lib/share/links";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { debugError } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Outcome =
  | { kind: "verified"; email: string; again: boolean }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

/** The workspace a slug belongs to, whether it is a document link or a data room link. */
async function orgIdForShareId(shareId: string): Promise<Types.ObjectId | null> {
  const doc = await resolveShareLink(shareId).catch(() => null);
  const docOrg = doc?.doc?.orgId;
  if (docOrg && Types.ObjectId.isValid(String(docOrg))) return new Types.ObjectId(String(docOrg));

  const project = await resolveProjectLink(shareId).catch(() => null);
  const projectOrg = project?.project?.orgId;
  if (projectOrg && Types.ObjectId.isValid(String(projectOrg))) return new Types.ObjectId(String(projectOrg));

  return null;
}

async function verify(token: string): Promise<Outcome> {
  const checked = verifyViewerEmailToken(token);
  if (!checked.ok) return checked.reason === "expired" ? { kind: "expired" } : { kind: "invalid" };

  try {
    await connectMongo();
    const orgId = await orgIdForShareId(checked.shareId);
    // The signature is good but the link it names is gone — a deleted document, a purged account.
    // Nothing to attach the confirmation to, and no workspace to tell.
    if (!orgId) return { kind: "unavailable" };

    const { newlyVerified } = await markViewerEmailVerified({
      orgId,
      email: checked.email,
      viewerKey: checked.viewerKey,
    });
    return { kind: "verified", email: checked.email, again: !newlyVerified };
  } catch (err) {
    debugError(1, "[share/verify] could not record confirmation", err);
    return { kind: "unavailable" };
  }
}

export default async function ShareVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params?.t) ? params.t[0] : params?.t;
  const token = (raw ?? "").trim();
  const outcome: Outcome = token ? await verify(token) : { kind: "invalid" };

  const { heading, body } = copyFor(outcome);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-4 py-16">
      <div className="w-full max-w-[460px] text-center">
        <div className="text-lg font-semibold text-[var(--fg)]">{heading}</div>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{body}</p>
        <Link
          href="/"
          className="mt-7 inline-flex items-center rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
        >
          About LinkDrop
        </Link>
      </div>
    </main>
  );
}

/**
 * One sentence per outcome, each of which has to answer "and now what?".
 *
 * The expired case matters most: the reader did the thing we asked, a day late, and the worst
 * answer is one that reads as a failure they have to fix. Nothing was lost — the introduction was
 * recorded when they typed it — so the copy says exactly that instead of offering a new link,
 * which would need them to go back and find the document again.
 */
function copyFor(outcome: Outcome): { heading: string; body: string } {
  switch (outcome.kind) {
    case "verified":
      return outcome.again
        ? {
            heading: "Already confirmed",
            body: `${outcome.email} was confirmed earlier. Nothing more to do — the sender already sees your name on what you read.`,
          }
        : {
            heading: "Email confirmed",
            body: `Thanks — ${outcome.email} is confirmed. The person who shared the document now sees your name on what you read, rather than an anonymous reader.`,
          };
    case "expired":
      return {
        heading: "That link has expired",
        body: "Confirmation links last a day. Nothing was lost: your introduction was recorded when you gave it, and the sender can already see it — it is simply marked as unconfirmed.",
      };
    case "unavailable":
      return {
        heading: "We could not confirm that right now",
        body: "The link is valid but the document it belongs to is no longer available. Your introduction is unaffected.",
      };
    case "invalid":
    default:
      return {
        heading: "That confirmation link is not valid",
        body: "It may have been copied incompletely from the email. Try clicking the link in the message itself rather than pasting it.",
      };
  }
}
