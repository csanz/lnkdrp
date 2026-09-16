/**
 * Logged-out home page client UI for `/`.
 *
 * Purpose: Marketing landing page + short auth transition screen. Sign-in goes straight to Google.
 */
"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import PublicFooter from "@/components/PublicFooter";
import { CREDITS_COPY } from "@/lib/client/planLimit";
import PublicHeader from "@/components/PublicHeader";
import McpInstallExample from "@/components/McpInstallExample";
import Spinner from "@/components/ui/Spinner";
import { useAuthEnabled } from "@/app/providers";

const AUTH_TRANSITION_STORAGE_KEY = "ld_auth_transition";
const AUTH_TRANSITION_COOKIE_NAME = "ld_auth_transition";
const AUTH_TRANSITION_MAX_AGE_SECONDS = 30;

/**
 * Render the HomeUnauthedClient UI (uses effects, memoized values, local state).
 */
export default function HomeUnauthedClient({ authTransitionHint }: { authTransitionHint?: string }) {
  const router = useRouter();
  const authEnabled = useAuthEnabled();
  const [retryBusy, setRetryBusy] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const clearAuthTransitionMarkers = useCallback(() => {
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

  /**
   * During certain flows (notably "create org → re-auth → auto-join"), the client intentionally
   * signs out and immediately redirects to Google with account selection.
   *
   * In that brief window, we do NOT want to render the logged-out marketing UI.
   */
  const authTransition = useMemo(() => {
    if (!authEnabled) return null;
    // Prefer the server-provided hint (cookie) so SSR + initial client render agree (no hydration mismatch).
    if (typeof authTransitionHint === "string" && authTransitionHint.trim()) return authTransitionHint.trim();
    try {
      const raw = sessionStorage.getItem(AUTH_TRANSITION_STORAGE_KEY) ?? "";
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { kind?: unknown; at?: unknown };
      const at = typeof parsed?.at === "number" ? parsed.at : 0;
      const kind = typeof parsed?.kind === "string" ? parsed.kind : "";
      // Expire quickly so a stale flag can't "trap" users on a blank screen.
      if (!at || Date.now() - at > 30_000) {
        clearAuthTransitionMarkers();
        return null;
      }
      return kind || "auth-transition";
    } catch {
      return null;
    }
  }, [authEnabled, authTransitionHint, clearAuthTransitionMarkers]);


  // If we ever render the transition screen (cookie/sessionStorage), clear markers after a short delay.
  // This prevents a stale marker from trapping the user if they cancel the Google flow and come back.
  useEffect(() => {
    if (!authEnabled) return;
    if (!authTransition) return;
    const id = window.setTimeout(() => clearAuthTransitionMarkers(), AUTH_TRANSITION_MAX_AGE_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [authEnabled, authTransition, clearAuthTransitionMarkers]);

  /** Start Google sign-in and return to `/` afterwards. */
  const startAuthFlow = useCallback(() => {
    if (!authEnabled || isSigningIn) return;
    setIsSigningIn(true);
    void signIn("google", { callbackUrl: "/" });
  }, [authEnabled, isSigningIn]);

  if (authEnabled && authTransition) {
    return (
      <main className="relative h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
        <div className="relative z-10 mx-auto flex h-full w-full max-w-6xl items-center justify-center px-8 sm:px-10 lg:px-12">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
            <div className="flex items-center gap-4">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5">
                <Image src="/icon-white.svg?v=3" alt="" width={18} height={18} />
              </div>
              <div>
                <div className="text-base font-semibold tracking-tight">Switching accounts…</div>
                <p className="mt-1 text-sm text-white/60">Continuing to Google sign-in.</p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                disabled={retryBusy}
                aria-busy={retryBusy}
                onClick={() => {
                  if (retryBusy) return;
                  setRetryBusy(true);
                  void (async () => {
                    try {
                      // Best-effort retry: if the original redirect to Google failed (network/cancel),
                      // let the user restart the flow from here.
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const res = await signIn(
                        "google",
                        { callbackUrl: "/", redirect: false },
                        { prompt: "select_account" } as any,
                      );
                      if (res?.url) window.location.assign(res.url);
                      else {
                        // Fall back to the login route so the user can retry manually.
                        clearAuthTransitionMarkers();
                        router.push("/login");
                      }
                    } finally {
                      setRetryBusy(false);
                    }
                  })();
                }}
              >
                {retryBusy ? "Retrying…" : "Try again"}
              </button>
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
                onClick={() => {
                  clearAuthTransitionMarkers();
                  router.push("/login");
                }}
              >
                Go to login
              </button>
            </div>
          </div>
        </div>
        <PublicFooter className="absolute inset-x-0 bottom-3 sm:bottom-4" containerClassName="px-3 sm:px-4" />
      </main>
    );
  }

  return (
    <main className="relative min-h-[100svh] w-full overflow-x-hidden bg-[#050506] text-white">
      {/* Full-bleed animation background (visual only), framed to the first viewport so the
          plane sits beside the headline regardless of page length. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 hidden h-[100svh] md:block">
        <iframe
          title="Paperplane animation"
          src="/paperplane/index.html"
          className="h-full w-full border-0"
          loading="eager"
          referrerPolicy="no-referrer"
        />
        {/* Soft horizon: fade the globe out before the frame ends instead of a hard clip. Sized to
            the frame so an 800-tall fold keeps as much of the rim as a 1080-tall one. */}
        <div className="absolute inset-x-0 bottom-0 h-[14svh] bg-gradient-to-t from-[#050506] to-transparent" />
      </div>

      {/* Soft lighting on top of the animation. The first two pools are anchored in svh so the
          fold reads exactly as the animation frame; the third pools just under the fold where the
          globe fades, so the exchange half of the page is not dead ground. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20svh, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60svh, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% calc(100svh + 40px), rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Small screens hide the animation: give the top-right a wash sized to the viewport, a very
          faint pool at the right edge beside the install panel, plus a wide lower-left pool so
          the exchange and footer don't sit on a dead field. */}
      <div
        className="pointer-events-none absolute inset-0 md:hidden"
        style={{
          background:
            "radial-gradient(90vw 70vw at 100% 0%, rgba(255,255,255,0.14), rgba(255,255,255,0) 65%), radial-gradient(70vw 50vw at 100% 70%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%), radial-gradient(110vw 80vw at 0% 100%, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Overlay (real HTML text + buttons) */}
      <div className="relative z-10 min-h-[100svh] w-full">
        {/* Header placement intentionally matches share pages (`/s/:shareId`, `/p/:shareId`);
            the container is aligned to the hero column so the logo sits over the eyebrow. */}
        <PublicHeader />

        <section className="mx-auto w-full max-w-6xl px-8 pb-24 pt-12 sm:px-10 md:pt-16 lg:px-12">
          <div className="w-full md:w-[min(560px,54%)]">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">MCP · API · CLI</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px] lg:text-[64px]">
              Easy, trackable share links built for AI agents
            </h1>

            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              Generate share links from your favorite AI agent through our MCP interface, then track clicks and
              usage through your agent or our dashboard. Every link opens with an AI summary and key points, so
              recipients (and their own agents) know what they&apos;re getting before they commit time.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-2">
              {authEnabled ? (
                // The label stays in the box (just `invisible`) instead of being swapped out, so
                // the button's width is always exactly its own resting width in both states — no
                // guessed min-width, and nothing to get wrong if the label ever changes. The
                // spinner overlays it centered; busy shows no provider name on purpose, for when
                // more sign-in methods join Google.
                <button
                  type="button"
                  className="relative inline-flex h-10 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
                  onClick={startAuthFlow}
                  disabled={isSigningIn}
                  aria-busy={isSigningIn}
                >
                  <span className={isSigningIn ? "invisible" : ""}>Get Started</span>
                  {isSigningIn ? (
                    <span className="absolute inset-0 grid place-items-center">
                      <Spinner className="h-4 w-4" label="Signing in" />
                    </span>
                  ) : null}
                </button>
              ) : null}
              {authEnabled ? (
                <span className="text-[13px] leading-5 text-white/55">
                  Free to start — {CREDITS_COPY.freeStarter} AI credits included, no card needed.{" "}
                  <Link href="/pricing" className="underline underline-offset-4 hover:text-white/75">
                    See pricing
                  </Link>
                  .
                </span>
              ) : (
                <div className="text-sm text-white/60">Login isn’t available (auth is disabled).</div>
              )}
            </div>

            {/* Was "Built for thousands of links a minute…" — an unverified throughput number.
                Kept the distinctive half of the claim (agents, not people) and swapped the number
                for a property that's true regardless of scale. */}
            <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
              High-volume, high-performance link creation — by agents, not people
            </p>

            <McpInstallExample />
          </div>
        </section>

        {/* Mobile: the plane and globe live in a short frame at the end of the page instead of behind the hero. */}
        <div aria-hidden="true" className="relative -mt-6 h-[64svh] min-h-[360px] w-full md:hidden">
          <iframe
            title=""
            tabIndex={-1}
            src="/paperplane/index.html?yfrac=0.38&xfrac=0&minaspect=0.5"
            className="pointer-events-none absolute inset-0 h-full w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#050506] to-transparent" />
        </div>
      </div>

      {/* Aligned to the hero column (not corner-pinned) so it reads as the page's last line. */}
      <PublicFooter className="absolute inset-x-0 bottom-4" />
    </main>
  );
}
