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
import { useAuthEnabled } from "@/app/providers";
import { CREDITS_COPY, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import Spinner from "@/components/ui/Spinner";

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
 * Render the login page (single "Continue with Google" entrypoint).
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

  return (
    <main className="grid min-h-[100svh] place-items-center bg-[#050506] px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
        <h1 className="text-xl font-semibold tracking-tight">Log in or sign up</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">{helperText}</p>

        {/* What a new account gets, stated before sign-up: links are free; the starter credits exist to try the AI features. */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5">
          <div className="text-[13px] font-semibold text-white">New accounts start free</div>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-5 text-white/65">
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-white/40" />
              <span>3 share links with view and download tracking, free forever.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-white/40" />
              <span>
                {CREDITS_COPY.freeStarter} free credits to try the AI features: summaries on every link and AI compare between versions.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-white/40" />
              <span>Once they run out, {whatHappensAfterFreeCredits()}.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-white/40" />
              <span>{CREDITS_COPY.noCardToStart}</span>
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {/* The label stays in the box (just `invisible`) instead of being swapped out, so the
              button's width is always exactly its own resting width in both states — no guessed
              min-width. The spinner overlays it centered; busy shows no provider name on purpose,
              for when more sign-in methods join Google. */}
          <button
            type="button"
            className="relative inline-flex h-10 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
            disabled={!authEnabled || busy}
            aria-busy={busy}
            onClick={() => {
              if (!authEnabled || busy) return;
              setBusy(true);
              void signIn("google", { callbackUrl: next });
            }}
          >
            <span className={busy ? "invisible" : ""}>Continue with Google</span>
            {busy ? (
              <span className="absolute inset-0 grid place-items-center">
                <Spinner className="h-4 w-4" label="Signing in" />
              </span>
            ) : null}
          </button>

          <Link
            href="/"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
          >
            Back
          </Link>
        </div>
      </div>
    </main>
  );
}
