/**
 * Page for `/download/:token`.
 *
 * Approved download claim flow:
 * - Bootstraps invite-gating cookie (so NextAuth sign-in can proceed)
 * - Ensures the user is signed in
 * - Allows downloading the PDF or saving it into their account
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { fetchJson } from "@/lib/http/fetchJson";

type Step = "bootstrapping" | "auth" | "loading" | "ready" | "saving" | "error";

export default function DownloadClaimPage() {
  const params = useParams<{ token: string }>();
  const token = useMemo(() => decodeURIComponent(params?.token ?? "").trim(), [params?.token]);
  const { status } = useSession();

  const [step, setStep] = useState<Step>("bootstrapping");
  const [error, setError] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStep("error");
      setError("Missing download token.");
      return;
    }

    if (status === "loading") return;

    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        setStep("bootstrapping");

        // Allow auth endpoints to proceed if invite-gated.
        await fetchJson(`/api/download/bootstrap?token=${encodeURIComponent(token)}`, { method: "GET" });

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

        if (cancelled) return;
        setStep("loading");
        const info = await fetchJson<{ ok?: boolean; doc?: { title?: string } }>(`/api/download/${encodeURIComponent(token)}`, {
          method: "GET",
          cache: "no-store",
        });
        const title = typeof info?.doc?.title === "string" ? info.doc.title : null;
        setDocTitle(title);
        setStep("ready");
      } catch (e) {
        if (cancelled) return;
        setStep("error");
        setError(e instanceof Error ? e.message : "Failed to load download link.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, token]);

  return (
    <main className="grid min-h-[100svh] place-items-center bg-[#050506] px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
        <div className="text-lg font-semibold tracking-tight">
          {docTitle ? docTitle : "Download"}
        </div>
        <div className="mt-2 text-sm text-white/60">
          {step === "bootstrapping"
            ? "Preparing sign-in…"
            : step === "auth"
              ? "Redirecting to Google…"
              : step === "loading"
                ? "Loading…"
                : step === "saving"
                  ? "Saving…"
                  : step === "ready"
                    ? "Choose an action."
                    : "Couldn’t open this link."}
        </div>

        {error ? <div className="mt-4 text-sm font-medium text-red-300">{error}</div> : null}

        {step === "ready" ? (
          <div className="mt-6 flex flex-col gap-3">
            <a
              className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
              href={`/api/download/${encodeURIComponent(token)}/pdf`}
            >
              Download PDF
            </a>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
              onClick={() => {
                if (step !== "ready") return;
                setStep("saving");
                setError(null);
                void (async () => {
                  try {
                    const res = await fetchJson<{ ok?: boolean; docId?: string }>(
                      `/api/download/${encodeURIComponent(token)}/save`,
                      { method: "POST" },
                    );
                    const docId = typeof res?.docId === "string" ? res.docId : "";
                    if (!docId) throw new Error("Save failed.");
                    if (typeof window !== "undefined") window.location.assign(`/doc/${encodeURIComponent(docId)}`);
                  } catch (e) {
                    setStep("ready");
                    setError(e instanceof Error ? e.message : "Failed to save.");
                  }
                })();
              }}
            >
              Save to my account
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

