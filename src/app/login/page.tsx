/**
 * Login page for `/login`.
 *
 * Provides a direct NextAuth Google sign-in entrypoint.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";

const AUTH_TRANSITION_STORAGE_KEY = "ld_auth_transition";
const AUTH_TRANSITION_COOKIE_NAME = "ld_auth_transition";

/**
 * Render the login page (single "Continue with Google" entrypoint).
 */
export default function LoginPage() {
  const authEnabled = useAuthEnabled();
  const [busy, setBusy] = useState(false);

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
    return "Continue to LinkDrop with Google.";
  }, [authEnabled]);

  return (
    <main className="grid min-h-[100svh] place-items-center bg-[#050506] px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
        <h1 className="text-xl font-semibold tracking-tight">Log in</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">{helperText}</p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
            disabled={!authEnabled || busy}
            aria-busy={busy}
            onClick={() => {
              if (!authEnabled || busy) return;
              setBusy(true);
              void signIn("google", { callbackUrl: "/" });
            }}
          >
            {busy ? "Opening Google…" : "Continue with Google"}
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
