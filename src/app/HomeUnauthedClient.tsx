"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import AboutCopy from "@/components/AboutCopy";
import Modal from "@/components/modals/Modal";
import { useAuthEnabled } from "@/app/providers";

type PendingRoute = "/login";

const INVITE_CODE_STORAGE_KEY = "ld_invite_code";
const AUTH_TRANSITION_STORAGE_KEY = "ld_auth_transition";
const AUTH_TRANSITION_COOKIE_NAME = "ld_auth_transition";
const AUTH_TRANSITION_MAX_AGE_SECONDS = 30;
/**
 * Normalize Invite Code (uses toUpperCase, trim, replace).
 */


function normalizeInviteCode(input: string) {
  // Accept common copy/paste formats (spaces/dashes) and normalize for matching.
  return input.replace(/[^a-z0-9]/gi, "").trim().toUpperCase();
}
/**
 * Read Stored Invite Code (uses getItem, normalizeInviteCode).
 */


function readStoredInviteCode(): string {
  try {
    const raw = localStorage.getItem(INVITE_CODE_STORAGE_KEY) ?? "";
    return raw ? normalizeInviteCode(raw) : "";
  } catch {
    return "";
  }
}
/**
 * Write Stored Invite Code (uses normalizeInviteCode, setItem).
 */


function writeStoredInviteCode(code: string) {
  try {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return;
    localStorage.setItem(INVITE_CODE_STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
}
/**
 * Render the HomeUnauthedClient UI (uses effects, memoized values, local state).
 */


export default function HomeUnauthedClient({ authTransitionHint }: { authTransitionHint?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authEnabled = useAuthEnabled();
  const [retryBusy, setRetryBusy] = useState(false);

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
   * In that brief window, we do NOT want to render the logged-out marketing/invite UI.
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

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);
  const [pendingRoute, setPendingRoute] = useState<PendingRoute>("/login");

  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isVerifyingInvite, setIsVerifyingInvite] = useState(false);

  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const [requestEmail, setRequestEmail] = useState("");
  const [requestDescription, setRequestDescription] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestDone, setRequestDone] = useState(false);
  const [requestDoneMessage, setRequestDoneMessage] = useState<string | null>(null);
  const [requestDoneKind, setRequestDoneKind] = useState<
    "created" | "already_requested" | "already_invited" | "already_has_account" | null
  >(null);
  const [isRequesting, setIsRequesting] = useState(false);

  const inviteNote = useMemo(() => "Invite required to continue.", []);

  // Load last-entered invite code (if any).
  useEffect(() => {
    const stored = readStoredInviteCode();
    if (stored) setInviteCode(stored);
  }, []);

  const refreshInviteStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/invites/status", { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { ok?: unknown };
      setInviteOk(data.ok === true);
      return data.ok === true;
    } catch {
      setInviteOk(false);
      return false;
    }
  }, []);

  const openInviteModal = useCallback(
    async (route: PendingRoute) => {
      setPendingRoute(route);
      setInviteError(null);
      setRequestError(null);
      setRequestDone(false);
      setRequestDoneMessage(null);
      setRequestDoneKind(null);
      setInviteModalOpen(true);
      // If the field is empty, prefill with any stored code.
      setInviteCode((prev) => (prev.trim() ? prev : readStoredInviteCode()));
      void refreshInviteStatus();
    },
    [refreshInviteStatus],
  );

  const openLoginModal = useCallback(() => {
    setInviteModalOpen(false);
    setLoginModalOpen(true);
  }, []);

  const verifyInvite = useCallback(
    async (code: string): Promise<boolean> => {
      if (isVerifyingInvite) return false;
      const trimmed = normalizeInviteCode(code);
      setInviteError(null);
      setIsVerifyingInvite(true);
      try {
        if (!trimmed) {
          const ok = await refreshInviteStatus();
          if (!ok) {
            setInviteError("Enter an invite code.");
            return false;
          }
          // Already invited: proceed to the next step (login).
          openLoginModal();
          return true;
        }

        writeStoredInviteCode(trimmed);
        const ac = new AbortController();
        const timeout = window.setTimeout(() => ac.abort(), 8_000);
        const res = await fetch("/api/invites/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
          signal: ac.signal,
        }).finally(() => window.clearTimeout(timeout));

        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        if (!res.ok) {
          setInviteError(typeof data.error === "string" ? data.error : "Invalid invite code");
          return false;
        }

        // Confirm the cookie actually got set; otherwise we'd "succeed" but still be gated.
        const ok = await refreshInviteStatus();
        if (!ok) {
          setInviteError(
            "Invite accepted, but your browser didn’t store the unlock cookie. Check cookie settings and try again.",
          );
          return false;
        }

        setInviteOk(true);
        // After a successful invite, proceed to login in a modal (instead of navigating to /login).
        openLoginModal();
        return true;
      } catch {
        setInviteError("Couldn’t verify invite code. Try again.");
        return false;
      } finally {
        setIsVerifyingInvite(false);
      }
    },
    [isVerifyingInvite, openLoginModal, refreshInviteStatus],
  );

  const submitInviteRequest = useCallback(async () => {
    if (isRequesting) return;
    setRequestError(null);
    setIsRequesting(true);
    try {
      const res = await fetch("/api/invites/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: requestEmail, description: requestDescription }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; kind?: unknown };
      if (!res.ok) {
        setRequestError(typeof data.error === "string" ? data.error : "Failed to submit request");
        return;
      }
      const kind =
        data.kind === "created" ||
        data.kind === "already_requested" ||
        data.kind === "already_invited" ||
        data.kind === "already_has_account"
          ? data.kind
          : "created";
      setRequestDoneKind(kind);
      setRequestDoneMessage(
        kind === "already_has_account"
          ? "You already have an account. Log in to continue."
          : kind === "already_invited"
            ? "We already sent an invite code to this email. Check your inbox (and spam), then enter the code above."
            : kind === "already_requested"
              ? "We already have your request for this email. Check your email soon."
              : "Request received. Check your email soon.",
      );
      setRequestDone(true);
    } catch {
      setRequestError("Failed to submit request");
    } finally {
      setIsRequesting(false);
    }
  }, [isRequesting, requestDescription, requestEmail]);

  // Auto-claim from email link: /?invite=CODE
  useEffect(() => {
    const code = normalizeInviteCode(searchParams.get("invite") ?? "");
    if (!code) return;
    setPendingRoute("/login");
    setInviteModalOpen(true);
    setInviteCode(code);
    writeStoredInviteCode(code);
    void verifyInvite(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If we ever render the transition screen (cookie/sessionStorage), clear markers after a short delay.
  // This prevents a stale marker from trapping the user if they cancel the Google flow and come back.
  useEffect(() => {
    if (!authEnabled) return;
    if (!authTransition) return;
    const id = window.setTimeout(() => clearAuthTransitionMarkers(), AUTH_TRANSITION_MAX_AGE_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [authEnabled, authTransition, clearAuthTransitionMarkers]);

  const startAuthFlow = useCallback(async () => {
    // If already invited (cookie set), skip straight to login.
    const ok = await refreshInviteStatus();
    if (ok) {
      openLoginModal();
      return;
    }

    // If the user previously entered a code, try it automatically.
    const stored = readStoredInviteCode();
    if (stored) {
      setInviteCode(stored);
      const verified = await verifyInvite(stored);
      if (verified) return;
      // Fall back to the invite modal so the user can correct the code.
      void openInviteModal("/login");
      return;
    }

    // No stored code and not already invited: ask for one.
    void openInviteModal("/login");
  }, [openInviteModal, openLoginModal, refreshInviteStatus, verifyInvite]);

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
                        // Fall back to login route (which can surface invite gating errors).
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
      </main>
    );
  }

  return (
    <main className="relative h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Full-bleed animation background (visual only) */}
      <iframe
        title="Paperplane animation"
        src="/paperplane/index.html"
        className="pointer-events-none absolute inset-0 h-full w-full border-0"
        loading="eager"
        referrerPolicy="no-referrer"
      />

      {/* Soft lighting on top of the animation */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Overlay (real HTML text + buttons) */}
      <div className="relative z-10 h-full w-full">
        {/* Full-width header: logo pinned left, auth links pinned right (match dashboard placement). */}
        <header className="w-full">
          <div className="flex h-14 items-center justify-between gap-3 px-3 md:h-auto md:items-start md:px-4 md:pb-7 md:pt-6">
            <div className="flex min-w-0 items-center gap-2">
              <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
                <Image
                  src="/icon-white.svg?v=3"
                  alt="LinkDrop"
                  width={31}
                  height={31}
                  priority
                  className="block"
                />
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
                onClick={() => setAboutModalOpen(true)}
              >
                About
              </button>
              <Link
                href="/tos"
                className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                Terms
              </Link>
              <Link
                href="/privacy"
                className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                Privacy
              </Link>
              <button
                type="button"
                className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
                onClick={() => void startAuthFlow()}
              >
                Log In
              </button>
            </div>
          </div>
        </header>

        <section className="mx-auto w-full max-w-6xl px-8 pt-12 sm:px-10 md:pt-16 lg:px-12">
          <div className="w-full md:w-[min(560px,54%)]">
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[64px]">
              Sending docs should feel effortless to share
            </h1>

            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              Doc and link sharing that gives the reader context before they commit time.
            </p>
            <p className="mt-4 text-xs font-medium text-white/45">{inviteNote}</p>

            <div className="mt-7 flex items-center gap-4">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
                onClick={() => void startAuthFlow()}
              >
                Get Started
              </button>
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        ariaLabel="Invite code"
        panelClassName="bg-[#0b0b0c] text-white border-white/10"
        contentClassName="px-8 pb-8 pt-7"
      >
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5">
              <Image src="/icon-white.svg?v=3" alt="" width={18} height={18} />
            </div>
            <div>
              <div className="text-base font-semibold tracking-tight">Invite required</div>
              <p className="mt-1 text-sm text-white/60">Enter an invite code to continue.</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-white/85">Invite code</div>
            <div className="flex gap-2">
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void verifyInvite(inviteCode);
                }}
                placeholder="e.g. ABC123"
                autoComplete="off"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/20"
              />
              <button
                type="button"
                className="shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-70"
                onClick={() => void verifyInvite(inviteCode)}
                disabled={isVerifyingInvite}
              >
                {isVerifyingInvite ? "Checking…" : inviteOk === true && !inviteCode.trim() ? "Continue" : "Continue"}
              </button>
            </div>
            {inviteOk === true && !inviteCode.trim() ? (
              <div className="text-xs font-medium text-emerald-300">
                Invite already accepted. Continue to proceed.
              </div>
            ) : null}
            {inviteError ? <div className="text-xs font-medium text-red-300">{inviteError}</div> : null}
          </div>

          <div className="border-t border-white/10 pt-5">
            <div className="text-sm font-semibold text-white/85">Request an invite</div>
            <p className="mt-1 text-xs text-white/55">Tell us what you need to share and we’ll get back to you.</p>

            {requestDone ? (
              <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
                <div>{requestDoneMessage ?? "Request received. Check your email soon."}</div>
                {requestDoneKind === "already_has_account" ? (
                  <div className="mt-3 flex items-center justify-end">
                    <button
                      type="button"
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
                      onClick={() => openLoginModal()}
                    >
                      Log in
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <input
                  value={requestEmail}
                  onChange={(e) => setRequestEmail(e.target.value)}
                  placeholder="Email"
                  autoComplete="email"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
                <textarea
                  value={requestDescription}
                  onChange={(e) => setRequestDescription(e.target.value)}
                  placeholder="What do you need to share?"
                  rows={3}
                  className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-70"
                    onClick={() => void submitInviteRequest()}
                    disabled={isRequesting}
                  >
                    {isRequesting ? "Sending…" : "Request invite"}
                  </button>
                </div>
                {requestError ? <div className="text-xs font-medium text-red-300">{requestError}</div> : null}
              </div>
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
        ariaLabel="About"
        panelClassName="w-[min(760px,calc(100vw-32px))]"
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/5">
            <Image src="/icon-white.svg?v=3" alt="" width={18} height={18} />
          </div>
          <div className="text-base font-semibold text-white">About</div>
        </div>
        <div className="mt-3">
          <AboutCopy />
        </div>
      </Modal>

      <Modal
        open={loginModalOpen}
        onClose={() => {
          setIsSigningIn(false);
          setLoginModalOpen(false);
        }}
        ariaLabel="Login"
        // Logged-out landing page is intentionally always dark → keep login modal dark too.
        // Also override CSS vars used by the shared Modal close button so hover states stay dark-friendly
        // even if the user selected Light theme globally.
        panelClassName={[
          // Use `!` to guarantee this wins over the shared Modal base `bg-[var(--panel)]` utility.
          "!bg-[#0b0b0c] !text-white !border-white/10",
          "[--fg:#e7e7ea] [--muted:#b3b3bb] [--muted-2:#8b8b96] [--panel-hover:rgba(255,255,255,0.08)]",
        ].join(" ")}
        contentClassName="px-8 pb-8 pt-7"
      >
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5">
              <Image src="/icon-white.svg?v=3" alt="" width={18} height={18} />
            </div>
            <div>
              <div className="text-base font-semibold tracking-tight">Log in</div>
              <p className="mt-1 text-sm text-white/60">Continue to LinkDrop.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {authEnabled ? (
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
                onClick={() => {
                  if (isSigningIn) return;
                  setIsSigningIn(true);
                  void signIn("google", { callbackUrl: "/" });
                }}
                disabled={isSigningIn}
                aria-busy={isSigningIn}
              >
                {isSigningIn ? "Opening Google…" : "Continue with Google"}
              </button>
            ) : (
              <div className="text-sm text-white/60">Login isn’t available (auth is disabled).</div>
            )}

            <button
              type="button"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
              onClick={() => {
                setIsSigningIn(false);
                setLoginModalOpen(false);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      </Modal>
    </main>
  );
}


