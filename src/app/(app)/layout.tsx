/**
 * Layout for the authenticated app shell routes under `src/app/(app)/*`.
 *
 * It is also where the early-access queue is enforced. The check is here, on the server, rather
 * than in the client shell: a redirect that depends on JavaScript having run is a redirect a
 * queued visitor can watch the app render behind. One indexed read by user id, on a layout that
 * every app route already passes through.
 */
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { readWaitlistState } from "@/lib/waitlist/waitlist";
import AppShellLayout from "./AppShellLayout";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const userId = typeof session?.user?.id === "string" ? session.user.id : "";
  if (userId) {
    const { status } = await readWaitlistState(userId);
    if (status === "waitlisted") redirect("/waitlist");
  }
  return <AppShellLayout>{children}</AppShellLayout>;
}
