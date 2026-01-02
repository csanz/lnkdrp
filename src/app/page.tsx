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

  // Authenticated users should never see the marketing animation; show the upload home directly.
  return session ? <HomeAuthedClient /> : <HomeUnauthedClient authTransitionHint={authTransitionHint} />;
}


