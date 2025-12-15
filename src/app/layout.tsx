import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "LinkDrop — Share Docs",
    template: "%s — LinkDrop",
  },
  description: "Share your docs with a simple link.",
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    title: "LinkDrop — Share Docs",
    description: "Share your docs with a simple link.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "LinkDrop — Share Docs",
    description: "Share your docs with a simple link.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
