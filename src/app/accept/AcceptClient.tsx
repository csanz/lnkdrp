/**
 * The invitation screen on `/accept`. Every decision about who sees this is made on the server; the
 * only interactive thing here is the button.
 *
 * Built on the same page as `/waitlist` on purpose, and it is the same person seeing it minutes
 * apart: the lit dark ground, the `max-w-6xl` two-column grid, the serif display line, and the
 * account card on the right. Continuity is the point — the card that said **Queued** an hour ago
 * says **Invited** now, in the same place, which does more to say "you're in" than any copy would.
 *
 * One thing is deliberate and worth not undoing: **there is no tick-box.** A checkbox beside a
 * button is a second thing to click that changes nothing about what was agreed, and its usual job
 * is to make a refusal defensible rather than to inform anyone. The sentence sits directly above
 * the button, with both documents one tap away, and the record written is the same either way.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PRIVACY_URL, TERMS_URL } from "@/lib/legal/terms";

export default function AcceptClient({
  token,
  firstName,
  name,
  email,
  image,
  initials,
  freeDocuments,
  freeCredits,
}: {
  token: string;
  firstName: string;
  name: string;
  email: string;
  image: string;
  initials: string;
  freeDocuments: number;
  freeCredits: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/waitlist/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(token ? { token } : {}),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
      if (!res.ok) {
        // A reload re-runs the server checks, which produce a real explanation for every one of
        // these — a stale session, a link that expired while the page sat open, the wrong account.
        // Guessing here would only be a worse version of that page.
        if (json?.error === "AUTH_REQUIRED" || json?.error === "WRONG_ACCOUNT" || json?.reason === "expired") {
          window.location.reload();
          return;
        }
        throw new Error("That did not go through. Try again.");
      }
      // `/welcome` is next for a brand-new account, and it is what `needsFirstRun` decides.
      router.push("/welcome");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not go through. Try again.");
      setBusy(false);
    }
  }

  const link = "text-white underline underline-offset-4 decoration-white/40 hover:decoration-white";

  return (
    // `items-start` so the card is as tall as what is in it. Grid items stretch by default, and
    // the right column has less content than the left, so it was drawing a box with a third of its
    // height empty — which read as something failing to load.
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] md:items-start md:gap-12">
      {/* What is being agreed, and the one button that agrees to it. */}
      <div className="max-w-xl">
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Early access</p>
        <h1 className="font-serif text-[40px] leading-[1.05] tracking-tight text-white sm:text-5xl">
          {firstName ? `You're in, ${firstName}.` : "You're in."}
        </h1>
        <p className="mt-5 max-w-md text-[15px] leading-6 text-white/60">
          Your account is open. One thing before you upload anything, and then it is out of the way
          for good.
        </p>

        <div className="mt-7 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4">
          <p className="text-[14px] leading-6 text-white/85">
            By accepting, you agree to the{" "}
            <Link href={TERMS_URL} className={link} target="_blank" rel="noreferrer">
              Terms of Service
            </Link>{" "}
            and the{" "}
            <Link href={PRIVACY_URL} className={link} target="_blank" rel="noreferrer">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="mt-2.5 text-[13px] leading-6 text-white/45">
            The short version: the documents you upload are yours, we do not sell anything about
            them or who reads them, and you can delete your account and everything in it whenever
            you want.
          </p>
        </div>

        {problem ? <p className="mt-6 text-[13px] text-amber-200">{problem}</p> : null}

        <div className="mt-7 flex flex-wrap items-center gap-5">
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy}
            className="rounded-xl bg-white px-5 py-2.5 text-[14px] font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
          >
            {busy ? "One moment…" : "Accept and start"}
          </button>
          <Link
            href="/"
            className="text-[13px] text-white/45 underline-offset-4 transition-colors hover:text-white hover:underline"
          >
            Not now
          </Link>
        </div>
      </div>

      {/* The same card that said Queued, saying something else. */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-7">
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

        <div className="mt-5 overflow-hidden rounded-xl bg-white/10 p-px">
          <div className="bg-[#0a0a0c] px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Status</div>
            {/* Emerald where the queue was amber: the colour changing is half the message. */}
            <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-emerald-300/10 px-2.5 py-1 text-[12px] font-semibold text-emerald-200 ring-1 ring-emerald-300/25">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
              Invited
            </div>
            <div className="mt-2 text-[12px] text-white/45">Accept to open your workspace</div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[13px] leading-6 text-white/55">
          You start on Free: {freeDocuments} shared documents with tracking, unlimited links on each,
          and {freeCredits} credits for the AI features. No card.
        </div>
      </div>
    </div>
  );
}
