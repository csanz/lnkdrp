/**
 * Layout for the authenticated app shell routes under `src/app/(app)/*`.
 *
 * It is where a queued visitor is sent to `/waitlist`, and a brand-new account to `/welcome`. The
 * checks are here, on the server, rather than in the client shell: a redirect that depends on
 * JavaScript having run is a redirect a queued visitor can watch the app render behind.
 *
 * What it is **not** is the enforcement of the queue. It used to be the only place `accessStatus`
 * was read on any request path, which meant the queue stopped browsers and let accounts through:
 * the same cookie drives `/api/*`, and nothing there looked. The gate now lives in
 * `src/lib/gating/waitlist.ts` and this layout calls the same cached read, so the screen and the
 * endpoints cannot answer differently — and an admin approval that clears the cache clears it for
 * both at once.
 */
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { enforceEntryGates } from "@/lib/gating/entryGate";
import AppShellLayout from "./AppShellLayout";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // The same two gates the root route applies, from the same function — see `entryGate`.
  await enforceEntryGates(session?.user?.id);
  return <AppShellLayout>{children}</AppShellLayout>;
}
