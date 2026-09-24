/**
 * Login page for `/login`.
 *
 * Styled as one of the public pages (`/pricing`, `/about`): the same soft radial lighting, the same
 * `PublicHeader`/`PublicFooter`, the same serif headline and bordered card. Sign-in is a marketing
 * page as much as a form — for most people it is the first lnkdrp screen they ever see — and the
 * previous single dark card in the middle of nothing did not read like the rest of the product.
 *
 * Two arrivals land here and they need different words:
 *
 * - **A new or returning visitor** — "Log in or sign up", with what a free account gets.
 * - **Someone whose session ended mid-use** (`?signedOut=1`, set by `AuthGate`) — told plainly that
 *   they were signed out, and that signing back in returns them to the page they were on. Being
 *   bounced to a sign-up pitch with no explanation is the thing that reads as a bug.
 */
"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";
import { CREDITS_COPY, FREE_PLAN_LIMITS_COPY, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import Spinner from "@/components/ui/Spinner";
import { useQueued } from "./QueueContext";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";

const AUTH_TRANSITION_STORAGE_KEY = "ld_auth_transition";
const AUTH_TRANSITION_COOKIE_NAME = "ld_auth_transition";

/**
 * `?next=` is where a gated route sent the user from (`AuthGate` in `AppShellLayout.tsx`); accept
 * it as the post-sign-in destination only when it is unambiguously a same-site path, since it also
 * arrives on anyone's clicked link. `//host/...` parses as protocol-relative and `https://...` as
 * absolute; both are rejected, along with anything not starting with a single `/`.
 */
function safeNextPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("://")) return null;
  return raw;
}

/** Same inline checkmark as the pricing page's feature lists. */
function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="mt-[5px] h-3.5 w-3.5 shrink-0 text-white/70">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * `/login` reads `?next=` via `useSearchParams`, which requires a Suspense boundary around it at
 * the page level or `next build` fails to prerender the route.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}

/**
 * Render the login page (single Google entrypoint that both registers and signs in).
 */
function LoginPageInner() {
  const authEnabled = useAuthEnabled();
  const [busy, setBusy] = useState(false);
  const params = useSearchParams();
  const next = safeNextPath(params.get("next")) ?? "/";
  const signedOut = params.get("signedOut") === "1";

  useEffect(() => {
    // Ensure the "auth transition" interstitial can't trap the user if they navigated here.
    try {
      sessionStorage.removeItem(AUTH_TRANSITION_STORAGE_KEY);
    } catch {
      // ignore
    }
    try {
      document.cookie = `${AUTH_TRANSITION_COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
    } catch {
      // ignore
    }
  }, []);

  const queued = useQueued();
  const headline = signedOut ? "You’ve been signed out." : queued ? "Request early access." : "Log in or sign up.";
  const intro = useMemo(() => {
    if (!authEnabled) return "Login isn’t available right now: authentication is disabled on this build.";
    if (signedOut) {
      return next && next !== "/"
        ? "Your session ended, so we stopped here rather than showing you a half-loaded page. Sign back in and we’ll take you straight back to where you were."
        : "Your session ended, so we stopped here rather than showing you a half-loaded page. Sign back in to pick up where you left off.";
    }
    // The card has to say what actually happens when the button is pressed. It used to say only
    // what the account *is*, leaving the queue to a banner above it — which put "signing in puts
    // you on the list" directly above "New accounts start free" and a Sign up button.
    if (queued) {
      return "One button, no password to remember. Signing in puts you on the list rather than opening an account. We let people in a few at a time, and there is nothing to pay.";
    }
    return "One button, no password to remember. Accounts are free and nothing is charged until you choose a plan.";
  }, [authEnabled, signedOut, next, queued]);

  const perks: string[] = [
    `${FREE_PLAN_LIMITS_COPY.documents} shared documents with view and download tracking, free forever.`,
    `${CREDITS_COPY.freeStarter} free credits to try the AI features: summaries on every link, and AI compare between versions.`,
    `Once they run out, ${whatHappensAfterFreeCredits()}.`,
    CREDITS_COPY.noCardToStart,
  ];

  const button = (
    <>
      {/* The label stays in the box (just `invisible`) instead of being swapped out, so the button's
          width is always exactly its own resting width in both states — no guessed min-width. The
          spinner overlays it centered; busy shows no provider name on purpose, for when more
          sign-in methods join Google. */}
      <button
        type="button"
        className="relative inline-flex h-11 w-full items-center justify-center rounded-xl bg-white px-4 text-[15px] font-semibold text-black shadow-[0_20px_50px_-20px_rgba(255,255,255,0.45)] transition hover:bg-white/90 disabled:opacity-70"
        disabled={!authEnabled || busy}
        aria-busy={busy}
        onClick={() => {
          if (!authEnabled || busy) return;
          setBusy(true);
          void signIn("google", { callbackUrl: next });
        }}
      >
        <span className={busy ? "invisible" : ""}>
          {signedOut ? "Sign back in with Google" : queued ? "Request access with Google" : "Sign up or log in with Google"}
        </span>
        {busy ? (
          <span className="absolute inset-0 grid place-items-center">
            <Spinner className="h-4 w-4" label="Signing in" />
          </span>
        ) : null}
      </button>
    </>
  );

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

        <section className="mx-auto flex w-full max-w-6xl flex-1 items-center px-8 pb-16 pt-10 sm:px-10 md:pt-14 lg:px-12">
          <div className="grid w-full gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] md:items-center md:gap-14">
            {/* Left: what this page is. */}
            <div className="max-w-xl">
              <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
                {signedOut ? "Signed out" : "Welcome"}
              </p>
              <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl md:text-[52px]">
                {headline}
              </h1>
              <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">{intro}</p>
              {!signedOut ? (
                <p className="mt-4 max-w-lg text-[13px] leading-6 text-white/45">
                  Wondering what it costs?{" "}
                  <Link href="/pricing" className="underline underline-offset-4 hover:text-white/70">
                    See pricing
                  </Link>{" "}
                  ·{" "}
                  <Link href="/mcp" className="underline underline-offset-4 hover:text-white/70">
                    Connect your agent
                  </Link>
                </p>
              ) : null}
            </div>

            {/* Right: the card that signs you in. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
              {signedOut ? (
                <>
                  {button}
                  <p className="mt-4 text-center text-[12px] leading-5 text-white/45">
                    {next && next !== "/" ? "You’ll land back on the page you were reading." : "Signing in takes you back to your workspace."}
                  </p>
                  <div className="mt-4 flex items-center justify-center">
                    <Link href="/" className="text-[13px] font-medium text-white/55 transition hover:text-white">
                      Back to home
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
                    {queued ? "What you get once you're in" : "New accounts start free"}
                  </div>
                  <ul className="mt-5 space-y-2.5 text-sm leading-6">
                    {perks.map((perk) => (
                      <li key={perk} className="flex gap-2.5 text-white/75">
                        <Check />
                        <span>{perk}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-7">{button}</div>
                  <p className="mt-4 text-center text-[12px] leading-5 text-white/45">
                    By continuing you agree to our{" "}
                    <Link href="/tos" className="underline underline-offset-4 hover:text-white/70">
                      Terms
                    </Link>{" "}
                    and{" "}
                    <Link href="/privacy" className="underline underline-offset-4 hover:text-white/70">
                      Privacy Policy
                    </Link>
                    .
                  </p>
                </>
              )}
            </div>
          </div>
        </section>

        <PublicFooter className="pb-8" />
      </div>
    </main>
  );
}
