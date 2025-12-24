"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "@/components/modals/Modal";

type PendingRoute = "/client-upload" | "/login";

const INVITE_CODE_STORAGE_KEY = "ld_invite_code";

function normalizeInviteCode(input: string) {
  // Accept common copy/paste formats (spaces/dashes) and normalize for matching.
  return input.replace(/[^a-z0-9]/gi, "").trim().toUpperCase();
}

function readStoredInviteCode(): string {
  try {
    const raw = localStorage.getItem(INVITE_CODE_STORAGE_KEY) ?? "";
    return raw ? normalizeInviteCode(raw) : "";
  } catch {
    return "";
  }
}

function writeStoredInviteCode(code: string) {
  try {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return;
    localStorage.setItem(INVITE_CODE_STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);
  const [pendingRoute, setPendingRoute] = useState<PendingRoute>("/client-upload");

  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isVerifyingInvite, setIsVerifyingInvite] = useState(false);

  const [requestEmail, setRequestEmail] = useState("");
  const [requestDescription, setRequestDescription] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestDone, setRequestDone] = useState(false);
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
      setInviteModalOpen(true);
      // If the field is empty, prefill with any stored code.
      setInviteCode((prev) => prev.trim() ? prev : readStoredInviteCode());
      void refreshInviteStatus();
    },
    [refreshInviteStatus],
  );

  const verifyInvite = useCallback(
    async (code: string) => {
      if (isVerifyingInvite) return;
      const trimmed = normalizeInviteCode(code);
      setInviteError(null);
      setIsVerifyingInvite(true);
      try {
        if (!trimmed) {
          const ok = await refreshInviteStatus();
          if (!ok) {
            setInviteError("Enter an invite code.");
            return;
          }
          setInviteModalOpen(false);
          router.push(pendingRoute);
          return;
        }

        writeStoredInviteCode(trimmed);
        const res = await fetch("/api/invites/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        if (!res.ok) {
          setInviteError(typeof data.error === "string" ? data.error : "Invalid invite code");
          return;
        }
        setInviteOk(true);
        setInviteModalOpen(false);
        router.push(pendingRoute);
      } catch {
        setInviteError("Couldn’t verify invite code. Try again.");
      } finally {
        setIsVerifyingInvite(false);
      }
    },
    [isVerifyingInvite, pendingRoute, refreshInviteStatus, router],
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
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        setRequestError(typeof data.error === "string" ? data.error : "Failed to submit request");
        return;
      }
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
    setPendingRoute("/client-upload");
    setInviteModalOpen(true);
    setInviteCode(code);
    writeStoredInviteCode(code);
    void verifyInvite(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="relative h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Full-bleed animation background (visual only) */}
      <iframe
        title="Paperplane animation"
        src="/paperplane/index.html"
        className="pointer-events-none absolute inset-0 h-full w-full border-0"
        loading="lazy"
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
      <div className="relative z-10 mx-auto h-full w-full max-w-6xl px-6">
        <header className="flex items-center justify-between py-5">
          <a href="/" className="flex items-center gap-2.5">
            <Image src="/icon-white.svg?v=3" alt="LinkDrop" width={26} height={26} priority />
            <span className="text-sm font-semibold tracking-tight">LinkDrop</span>
          </a>
          <button
            type="button"
            className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
            onClick={() => void openInviteModal("/login")}
          >
            Log In
          </button>
        </header>

        <section className="pt-12 md:pt-16">
          <div className="w-full md:w-[min(560px,54%)]">
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[64px]">
              Sending docs
              <br />
              that feel like
              <br />
              soaring through
              <br />
              the skies
            </h1>

            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              Send a link that opens fast and feels effortless to review.
            </p>
            <p className="mt-4 text-xs font-medium text-white/45">{inviteNote}</p>

            <div className="mt-7 flex items-center gap-4">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
                onClick={() => void openInviteModal("/client-upload")}
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
                Request received. Check your email soon.
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
    </main>
  );
}





