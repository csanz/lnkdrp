import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/app/providers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

function getMetadataBase(): URL | undefined {
  const raw =
    (process.env.NEXT_PUBLIC_SITE_URL || "").trim() ||
    (process.env.NEXT_PUBLIC_APP_URL || "").trim() ||
    (process.env.NEXTAUTH_URL || "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3001" : "");

  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    // Handle scheme-less inputs like "localhost:3001" or "myapp.com".
    try {
      const withProto = raw.startsWith("localhost") ? `http://${raw}` : `https://${raw}`;
      return new URL(withProto);
    } catch {
      return undefined;
    }
  }
}

export const metadata: Metadata = {
  title: {
    default: "LinkDrop - Share Docs",
    template: "%s - LinkDrop",
  },
  description: "Share your docs with a simple link.",
  metadataBase: getMetadataBase(),
  openGraph: {
    title: "LinkDrop - Share Docs",
    description: "Share your docs with a simple link.",
    type: "website",
    images: [
      {
        url: "/images/og.png",
        width: 840,
        height: 491,
        alt: "LinkDrop - Share Docs",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "LinkDrop - Share Docs",
    description: "Share your docs with a simple link.",
    images: [
      {
        url: "/images/og.png",
        width: 840,
        height: 491,
        alt: "LinkDrop - Share Docs",
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

  const initialSession = enableAuth ? await getServerSession(authOptions) : null;

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
