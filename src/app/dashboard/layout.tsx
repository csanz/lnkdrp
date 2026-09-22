/**
 * The gate on `/dashboard/*`.
 *
 * `dashboard/page.tsx` is a client component and sits outside the `(app)` route group, so nothing
 * on the way in ever ran: a queued visitor, an account that had not accepted the Terms, and a
 * brand-new account that had never seen `/welcome` all got the dashboard. `/upload`, `/activity`
 * and `/connect` redirected correctly, because those are inside the group. Three sibling screens
 * behaved one way and three the other, and which was which was invisible from the routes.
 *
 * `entryGate.ts` predicted this in its own comment — "a third entry point will be someone
 * forgetting this again" — and named the defence: one function, called from each. This is that
 * call. A server layout is the only place it can go, because the page below it is a client
 * component and a redirect that waits for JavaScript is a redirect the visitor watches the app
 * render behind.
 *
 * Nothing leaked while it was open: every endpoint the dashboard fetches gates itself, so a queued
 * visitor saw a shell full of failed panels. That is still the screen saying yes while every
 * request says no.
 */
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { enforceEntryGates } from "@/lib/gating/entryGate";
import DashboardShell from "./dashboardShell";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  await enforceEntryGates(session?.user?.id);
  return <DashboardShell>{children}</DashboardShell>;
}
