import HomeAuthedClient from "@/app/HomeAuthedClient";
import HomeUnauthedClient from "@/app/HomeUnauthedClient";
import { cookies } from "next/headers";
/**
 * Home page for `/`.
 *
 * Server-renders either the authenticated app shell or the logged-out landing/login flow.
 */


function authIsEnabled() {
  return (
    !!process.env.MONGODB_URI &&
    !!process.env.NEXTAUTH_SECRET &&
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET
  );
}
/**
 * Render the Home UI.
 */


export default async function Home() {
  // Auth transition marker is set briefly during "switch account" flows so we can render a neutral
  // logged-out screen while NextAuth redirects to Google, without a UI flash.
  const cookieStore = await cookies();
  const authTransitionHint = cookieStore.get("ld_auth_transition")?.value ?? "";

  // If auth isn't configured, always show the marketing/invite page.
  if (!authIsEnabled()) return <HomeUnauthedClient authTransitionHint={authTransitionHint} />;

  // Import NextAuth pieces only when auth is enabled, to avoid env-var crashes at module import time.
  const [{ getServerSession }, { authOptions }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth"),
  ]);

  const session = await getServerSession(authOptions);

  /**
   * The root is an entry point, and entry points owe a signed-in visitor two redirects.
   *
   * This page sits outside the `(app)` route group, so the layout that gates every other
   * authenticated route does not run here — and `/` is exactly where sign-in lands you. A queued
   * visitor got the app home instead of `/waitlist`, and a new account never reached `/welcome`.
   * Imported lazily for the same reason `next-auth` is: this module must stay importable when auth
   * is not configured (see `authIsEnabled` above).
   */
  if (session) {
    const { enforceEntryGates } = await import("@/lib/gating/entryGate");
    await enforceEntryGates(session.user?.id);
  }

  // Authenticated users should never see the marketing animation; show the upload home directly.
  return session ? <HomeAuthedClient /> : <HomeUnauthedClient authTransitionHint={authTransitionHint} />;
}


