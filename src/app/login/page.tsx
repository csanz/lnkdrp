/**
 * Login page for `/login`.
 *
 * Provides a direct NextAuth Google sign-in entrypoint.
 */
"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useAuthEnabled } from "@/app/providers";
import { CREDITS_COPY, FREE_PLAN_LIMITS_COPY, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import Spinner from "@/components/ui/Spinner";
import BrandHeader from "@/components/BrandHeader";

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
  const next = safeNextPath(useSearchParams().get("next")) ?? "/";

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

  const helperText = useMemo(() => {
    if (!authEnabled) return "Login isn’t available (auth is disabled).";
    return "Sign in or create your account with Google.";
  }, [authEnabled]);

  // Perks list, styled after the checkmark treatment in UpgradeModal: the headline perk (the
  // starter credits — the thing sign-up actually gets you, vs. the other lines which are just
  // reassurance) gets the filled check and bold text, the rest get the plain outlined check.
  const perks: Array<{ text: React.ReactNode; lead?: boolean }> = [
    {
      text: (
        <>
          {CREDITS_COPY.freeStarter} free credits to try the AI features: summaries on every link and AI compare
          between versions.
        </>
      ),
      lead: true,
    },
    { text: `${FREE_PLAN_LIMITS_COPY.documents} shared documents with view and download tracking, free forever.` },
    { text: <>Once they run out, {whatHappensAfterFreeCredits()}.</> },
    { text: CREDITS_COPY.noCardToStart },
  ];

  return (
    <main className="flex min-h-[100svh] flex-col bg-[#050506] text-white">
      <BrandHeader logoHref="/" />
      <div className="grid flex-1 place-items-center px-6 py-10">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7 sm:px-9 sm:py-8">
          {/* No logo chip in the card: the page header right above already carries the logo. */}
          <h1 className="text-[19px] font-semibold leading-6 tracking-tight sm:text-xl">Log in or sign up</h1>
          <p className="mt-1 text-[13px] leading-5 text-white/55">{helperText}</p>

          {/* What a new account gets, stated before sign-up: links are free; the starter credits exist to try the AI features. */}
          <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">New accounts start free</p>
          <ul className="mt-2.5 space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">
            {perks.map((perk, i) => (
              <li key={i} className="flex items-start gap-3 text-[13px] leading-5 text-white/65">
                <span
                  aria-hidden="true"
                  className={[
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
                    perk.lead ? "bg-white text-black" : "border border-white/15 text-white/50",
                  ].join(" ")}
                >
                  <CheckIcon className="h-3 w-3" strokeWidth={3} />
                </span>
                <span className={perk.lead ? "font-medium text-white" : ""}>{perk.text}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6">
            {/* The label stays in the box (just `invisible`) instead of being swapped out, so the
                button's width is always exactly its own resting width in both states — no guessed
                min-width. The spinner overlays it centered; busy shows no provider name on purpose,
                for when more sign-in methods join Google. */}
            <button
              type="button"
              className="relative inline-flex h-11 w-full items-center justify-center rounded-xl bg-white px-4 text-[15px] font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
              disabled={!authEnabled || busy}
              aria-busy={busy}
              onClick={() => {
                if (!authEnabled || busy) return;
                setBusy(true);
                void signIn("google", { callbackUrl: next });
              }}
            >
              <span className={busy ? "invisible" : ""}>Sign up or log in with Google</span>
              {busy ? (
                <span className="absolute inset-0 grid place-items-center">
                  <Spinner className="h-4 w-4" label="Signing in" />
                </span>
              ) : null}
            </button>

            <div className="mt-4 flex items-center justify-center">
              <Link href="/" className="text-[13px] font-medium text-white/55 hover:text-white">
                Back to home
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
