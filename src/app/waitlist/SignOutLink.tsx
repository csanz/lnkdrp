"use client";

import { signOut } from "next-auth/react";

import { forgetSignedIn } from "@/lib/client/sessionMemory";

/** "Not you?" — the one control a queued person needs, since the app itself is closed to them. */
export default function SignOutLink() {
  return (
    <button
      type="button"
      className="text-[13px] font-medium text-white/45 underline underline-offset-4 transition hover:text-white/70"
      onClick={() => {
        forgetSignedIn();
        void signOut({ callbackUrl: "/" });
      }}
    >
      Sign out
    </button>
  );
}
