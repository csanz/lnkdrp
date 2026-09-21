/**
 * Page for `/org/join/:token`.
 *
 * Invite join flow:
 * - Ensures the user is signed in (Google)
 * - Asks them whether they actually want to join
 * - Only then claims the invite into an org membership and switches to the org
 *
 * The confirmation step is not decoration. This page used to claim the invite from a `useEffect`
 * on mount and then `window.location.assign('/org/switch?orgId=…')`, which meant that *opening a
 * URL* made you a member of someone else's workspace and silently repointed your active workspace
 * to it — the switch route only checks membership, which the claim had just granted. A link pasted
 * into a chat, a link preview fetcher, or a mis-click was enough, and the next PDF the victim
 * uploaded landed in the inviter's workspace. Joining is now a deliberate act: nothing is POSTed
 * until Join is clicked, and Cancel leaves the user exactly as they were.
 *
 * Known gap: there is no endpoint that resolves an invite token to its workspace name and role
 * without redeeming it (`POST /api/org-invites/claim` is the only reader of the token, and it
 * claims), so the confirmation can only name the account you are signed in as. If a read-only
 * invite-preview endpoint is ever added, show the workspace name and offered role here too.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { fetchJson } from "@/lib/http/fetchJson";
import BrandHeader from "@/components/BrandHeader";

/**
 * `confirm` is the resting state of this page: signed in, invite untouched, waiting on the human.
 * `declined` is deliberately distinct from `error` — nothing went wrong, and the link still works
 * if they change their mind.
 */
type Step = "auth" | "confirm" | "claiming" | "done" | "declined" | "error";

export default function OrgJoinPage() {
  const params = useParams<{ token: string }>();
  const token = useMemo(() => decodeURIComponent(params?.token ?? "").trim(), [params?.token]);
  const { data: session, status } = useSession();
  const [step, setStep] = useState<Step>("auth");
  const [error, setError] = useState<string | null>(null);

  const account =
    session?.user?.email?.trim() || session?.user?.name?.trim() || "";

  // Sign-in only. Signing in is not joining, so this side effect is safe to run on mount; the
  // claim below is not, and lives in the Join handler instead.
  useEffect(() => {
    if (!token) {
      setStep("error");
      setError("Missing invite token.");
      return;
    }

    // NextAuth can briefly report "loading" on first render after redirect.
    // If we call `signIn()` during that window, we can end up in a redirect loop.
    if (status === "loading") return;

    if (status === "authenticated") {
      // Back from Google (or already signed in): ask before doing anything. Don't stomp a state
      // the user has already moved past — a session refresh mid-claim must not bounce them back
      // to the confirmation screen.
      setStep((prev) => (prev === "auth" ? "confirm" : prev));
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        if (cancelled) return;
        setStep("auth");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await signIn(
          "google",
          { callbackUrl: typeof window !== "undefined" ? window.location.href : "/" },
          { prompt: "select_account" } as any,
        );
        if (!res) throw new Error("Couldn’t start sign-in.");
        // redirect
      } catch (e) {
        if (cancelled) return;
        setStep("error");
        setError(e instanceof Error ? e.message : "Failed to join org.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, token]);

  const join = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      setStep("claiming");

      // Claim invite. Expired, revoked and already-redeemed tokens all come back as
      // "Invalid or expired invite" from the route, and that message is what lands in `error`.
      const claim = await fetchJson<{ ok?: boolean; orgId?: string }>("/api/org-invites/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const orgId = typeof claim?.orgId === "string" ? claim.orgId : "";
      if (!orgId) throw new Error("Invite claim failed.");

      // Switch workspace (sets httpOnly cookie + redirects home). Only reachable from the Join
      // click, so the active workspace never moves without the user asking for it.
      setStep("done");
      if (typeof window !== "undefined") {
        window.location.assign(`/org/switch?orgId=${encodeURIComponent(orgId)}`);
      }
    } catch (e) {
      setStep("error");
      setError(e instanceof Error ? e.message : "Failed to join org.");
    }
  }, [token]);

  const title =
    step === "confirm"
      ? "Join this workspace?"
      : step === "declined"
        ? "You didn’t join"
        : step === "error"
          ? "Couldn’t join"
          : "Joining workspace…";

  const detail =
    step === "auth"
      ? "Redirecting to Google…"
      : step === "confirm"
        ? "Someone invited you to their lnkdrp workspace. Joining makes you a member and switches you into it."
        : step === "claiming"
          ? "Accepting invite…"
          : step === "done"
            ? "Switching workspace…"
            : step === "declined"
              ? "Nothing changed. The invite link still works if you change your mind."
              : "Couldn’t join.";

  return (
    <main className="flex min-h-[100svh] flex-col bg-[#050506] text-white">
      <BrandHeader logoHref="/" />
      <div className="grid flex-1 place-items-center px-6 py-10">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
          <div className="text-lg font-semibold tracking-tight">{title}</div>
          <div className="mt-2 text-sm text-white/60">{detail}</div>

          {step === "confirm" ? (
            <>
              {account ? (
                <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
                  <div className="text-white/50">Signed in as</div>
                  <div className="mt-0.5 font-medium break-all">{account}</div>
                </div>
              ) : null}
              {/* No preview endpoint exists for the token, so the workspace name and the role being
                  offered can't be shown before the claim. Say so rather than imply it's nothing. */}
              <div className="mt-3 text-xs text-white/40">
                The workspace name and your role are confirmed once you join.
              </div>
              <div className="mt-6 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void join()}
                  className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
                >
                  Join workspace
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep("declined");
                  }}
                  className="inline-flex items-center justify-center rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 hover:bg-white/5"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}

          {step === "declined" ? (
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className="inline-flex items-center justify-center rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 hover:bg-white/5"
              >
                Back
              </button>
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold text-white/60 hover:text-white"
              >
                Go home
              </Link>
            </div>
          ) : null}

          {error ? <div className="mt-4 text-sm font-medium text-red-300">{error}</div> : null}
        </div>
      </div>
    </main>
  );
}
