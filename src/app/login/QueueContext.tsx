"use client";

/**
 * Carries the server-only queue flag into the client sign-in card.
 *
 * `page.tsx` has to be a client component — it reads `?next=` and `?signedOut=` — and
 * `waitlistEnabled()` is server-only, so the card had no way to know. The first attempt worked
 * around that by putting the truth in a banner above the card and leaving the card generic. On
 * screen that reads as a contradiction: a notice saying "signing in puts you on the list" sitting
 * directly above an eyebrow saying "New accounts start free" and a button saying "Sign up".
 *
 * A context filled by the server layout rather than a `NEXT_PUBLIC_` mirror of the flag: a second
 * variable is a second thing to set, and the failure it invites is the two disagreeing — which is
 * the shape of the bug this exists to fix.
 */
import { createContext, useContext } from "react";

const QueuedContext = createContext(false);

export function QueuedProvider({ queued, children }: { queued: boolean; children: React.ReactNode }) {
  return <QueuedContext.Provider value={queued}>{children}</QueuedContext.Provider>;
}

/** True when signing in joins the waitlist instead of opening an account. */
export function useQueued(): boolean {
  return useContext(QueuedContext);
}
