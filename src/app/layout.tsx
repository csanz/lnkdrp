/**
 * Root layout for `/` (App Router).
 *
 * Sets up global styles/metadata and bootstraps auth-aware client providers with an initial server session.
 */
import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/app/providers";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getMetadataBaseUrl } from "@/lib/urls";

export const metadata: Metadata = {
  title: {
    default: "LinkDrop - Trackable share links for AI agents",
    template: "%s - LinkDrop",
  },
  description: "Trackable share links for PDFs, built for AI agents. Every link opens with a summary and key points.",
  // Absolute base for relative OG/Twitter image URLs. Resolved from
  // NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_APP_URL / NEXTAUTH_URL / VERCEL_URL,
  // falling back to the local dev origin (never throws on a malformed value).
  metadataBase: getMetadataBaseUrl(),
  openGraph: {
    title: "LinkDrop - Trackable share links for AI agents",
    description: "Trackable share links for PDFs, built for AI agents. Every link opens with a summary and key points.",
    type: "website",
    images: [
      {
        url: "/images/og.png",
        width: 840,
        height: 491,
        alt: "LinkDrop - Trackable share links for AI agents",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "LinkDrop - Trackable share links for AI agents",
    description: "Trackable share links for PDFs, built for AI agents. Every link opens with a summary and key points.",
    images: [
      {
        url: "/images/og.png",
        width: 840,
        height: 491,
        alt: "LinkDrop - Trackable share links for AI agents",
      },
    ],
  },
};
/**
 * Render the RootLayout UI.
 */


export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Mirror server debug level into the client runtime so client-side debug logs
  // can use the same switch as server logs.
  const debugLevelRaw =
    process.env.DEBUG_LEVEL ??
    (process.env.DEBUG_MODE === "verbose" ? "2" : undefined) ??
    (process.env.NODE_ENV === "development" ? "1" : "0");
  const debugLevel = Number(debugLevelRaw);

  const enableAuth =
    !!process.env.MONGODB_URI &&
    !!process.env.NEXTAUTH_SECRET &&
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET;

  let initialSession: Session | null = null;
  if (enableAuth) {
    try {
      initialSession = await getServerSession(authOptions);
    } catch (err) {
      // NextAuth can throw if a stale/invalid JWT session cookie can't be decrypted
      // (e.g. secret rotation). Treat that as "logged out" so the landing page renders.
      console.warn("[auth] getServerSession failed; falling back to null session", err);
      initialSession = null;
    }
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__DEBUG_LEVEL__=${Number.isFinite(debugLevel) ? debugLevel : 0};`,
          }}
        />
        <Providers enableAuth={enableAuth} initialSession={initialSession}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
