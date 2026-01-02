/**
 * Login page for `/login`.
 *
 * Provides a direct NextAuth Google sign-in entrypoint (invite-gated by `/api/auth/*`).
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";

const AUTH_TRANSITION_STORAGE_KEY = "ld_auth_transition";
const AUTH_TRANSITION_COOKIE_NAME = "ld_auth_transition";

export default function LoginPage() {
  const authEnabled = useAuthEnabled();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    return "Continue to LinkDrop with Google. (Access may require an invite.)";
  }, [authEnabled]);

  return (
    <main className="grid min-h-[100svh] place-items-center bg-[#050506] px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
        <h1 className="text-xl font-semibold tracking-tight">Log in</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">{helperText}</p>

        {error ? <div className="mt-4 text-sm font-medium text-red-300">{error}</div> : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
            disabled={!authEnabled || busy}
            aria-busy={busy}
            onClick={() => {
              if (!authEnabled) return;
              if (busy) return;
              setBusy(true);
              setError(null);
              void (async () => {
                try {
                  // Use redirect:false so we can surface invite gating errors (403 from /api/auth/signin).
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const res = await signIn(
                    "google",
                    { callbackUrl: "/", redirect: false },
                    { prompt: "select_account" } as any,
                  );
                  if (!res) {
                    setError("Couldn’t start sign-in. Please try again.");
                    return;
                  }
                  if (res.error) {
                    setError(res.error === "Invite required" ? "Invite required to sign in." : res.error);
                    return;
                  }
                  if (res.url) window.location.assign(res.url);
                  else setError("Couldn’t start sign-in. Please try again.");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn’t start sign-in. Please try again.");
                } finally {
                  setBusy(false);
                }
              })();
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





