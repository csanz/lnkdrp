/**
 * Layout for the authenticated app shell routes under `src/app/(app)/*`.
 *
 * It is where a queued visitor is sent to `/waitlist`. The check is here, on the server, rather
 * than in the client shell: a redirect that depends on JavaScript having run is a redirect a
 * queued visitor can watch the app render behind.
 *
 * What it is **not** is the enforcement of the queue. It used to be the only place `accessStatus`
 * was read on any request path, which meant the queue stopped browsers and let accounts through:
 * the same cookie drives `/api/*`, and nothing there looked. The gate now lives in
 * `src/lib/gating/waitlist.ts` and this layout calls the same cached read, so the screen and the
 * endpoints cannot answer differently — and an admin approval that clears the cache clears it for
 * both at once.
 */
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { readAccessStatus } from "@/lib/gating/waitlist";
import AppShellLayout from "./AppShellLayout";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const userId = typeof session?.user?.id === "string" ? session.user.id : "";
  if (userId) {
    // The position and the total belong to `/waitlist`, which reads them itself; all this needs is
    // the decision, so it takes the cached one rather than paying for two counts per navigation.
    if ((await readAccessStatus(userId)) === "waitlisted") redirect("/waitlist");
  }
  return <AppShellLayout>{children}</AppShellLayout>;
}
