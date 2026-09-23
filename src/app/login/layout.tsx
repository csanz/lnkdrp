/**
 * Server shell for `/login`, so the page can tell the truth about the queue.
 *
 * `page.tsx` is a client component - it reads `?next=` and `?signedOut=` with `useSearchParams` -
 * and `waitlistEnabled()` is server-only. Without a server parent to read it, the sign-in page
 * promised "New accounts start free" and a perks list, while every new account was being queued
 * and sent to `/waitlist` immediately after the Google consent screen.
 *
 * A layout rather than a `NEXT_PUBLIC_` mirror of the flag: a second variable is a second thing to
 * set, and the failure it invites is the two disagreeing - which is exactly the shape of the bug
 * this is fixing.
 */
import { waitlistEnabled } from "@/lib/waitlist/waitlist";

import { EarlyAccessNotice } from "./EarlyAccessNotice";
import { QueuedProvider } from "./QueueContext";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  const queued = waitlistEnabled();
  return (
    <QueuedProvider queued={queued}>
      <EarlyAccessNotice queued={queued} />
      {children}
    </QueuedProvider>
  );
}
