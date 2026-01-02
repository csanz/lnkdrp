/**
 * Page for `/org/join/:token`.
 *
 * Invite join flow:
 * - Bootstraps invite-gating cookie (so NextAuth sign-in can proceed)
 * - Ensures the user is signed in
 * - Claims the invite into an org membership
 * - Switches to the org
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { fetchJson } from "@/lib/http/fetchJson";

type Step = "bootstrapping" | "auth" | "claiming" | "done" | "error";

export default function OrgJoinPage() {
  const params = useParams<{ token: string }>();
  const token = useMemo(() => decodeURIComponent(params?.token ?? "").trim(), [params?.token]);
  const { status } = useSession();
  const [step, setStep] = useState<Step>("bootstrapping");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStep("error");
      setError("Missing invite token.");
      return;
    }

    // NextAuth can briefly report "loading" on first render after redirect.
    // If we call `signIn()` during that window, we can end up in a redirect loop.
    if (status === "loading") return;

    let cancelled = false;
    void (async () => {
      try {
        setStep("bootstrapping");
        setError(null);
        // 1) Allow auth endpoints to proceed if invite-gated.
        await fetchJson(`/api/org-invites/bootstrap?token=${encodeURIComponent(token)}`, { method: "GET" });

        // 2) Ensure signed in.
        if (cancelled) return;
        if (status !== "authenticated") {
          setStep("auth");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await signIn(
            "google",
            { callbackUrl: typeof window !== "undefined" ? window.location.href : "/" },
            { prompt: "select_account" } as any,
          );
          if (!res) throw new Error("Couldn’t start sign-in.");
          return; // redirect
        }

        // 3) Claim invite.
        if (cancelled) return;
        setStep("claiming");
        const claim = await fetchJson<{ ok?: boolean; orgId?: string }>("/api/org-invites/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const orgId = typeof claim?.orgId === "string" ? claim.orgId : "";
        if (!orgId) throw new Error("Invite claim failed.");

        // 4) Switch workspace (sets httpOnly cookie + redirects home).
        if (cancelled) return;
        setStep("done");
        if (typeof window !== "undefined") {
          window.location.assign(`/org/switch?orgId=${encodeURIComponent(orgId)}`);
        }
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

  return (
    <main className="grid min-h-[100svh] place-items-center bg-[#050506] px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
        <div className="text-lg font-semibold tracking-tight">Joining workspace…</div>
        <div className="mt-2 text-sm text-white/60">
          {step === "bootstrapping"
            ? "Preparing sign-in…"
            : step === "auth"
              ? "Redirecting to Google…"
              : step === "claiming"
                ? "Accepting invite…"
                : step === "done"
                  ? "Switching workspace…"
                  : "Couldn’t join."}
        </div>
        {error ? <div className="mt-4 text-sm font-medium text-red-300">{error}</div> : null}
      </div>
    </main>
  );
}


