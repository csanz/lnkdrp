"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Modal from "@/components/modals/Modal";
/**
 * Render the TempUserGateModal UI (uses local state).
 */


export default function TempUserGateModal({
  open,
  onClose,
  authEnabled,
}: {
  open: boolean;
  onClose: () => void;
  authEnabled: boolean;
}) {
  const [isSigningIn, setIsSigningIn] = useState(false);

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Sign up to save your work">
      <div className="text-base font-semibold text-zinc-900">Sign up to save your work</div>
      <div className="mt-3 text-sm leading-6 text-zinc-800">
        You’re currently using a temporary session. To keep your document and unlock more (more docs,
        more file replacements, and more reviews), please sign up or log in.
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {authEnabled ? (
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-70"
            onClick={() => {
              if (isSigningIn) return;
              setIsSigningIn(true);
              void signIn("google");
            }}
            disabled={isSigningIn}
            aria-busy={isSigningIn}
          >
            {isSigningIn ? "Opening Google…" : "Continue with Google"}
          </button>
        ) : (
          <div className="text-sm text-zinc-600">Login isn’t available (auth is disabled).</div>
        )}

        <button
          type="button"
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
          onClick={() => {
            setIsSigningIn(false);
            onClose();
          }}
        >
          Not now
        </button>
      </div>
    </Modal>
  );
}




