/**
 * Client shell for `/dashboard/*` — top bar (logo left, account menu right) + auth redirect.
 */
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import AccountMenu from "@/components/AccountMenu";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import { useAuthEnabled } from "@/app/providers";

function AuthRedirector() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "unauthenticated") return;
    if (typeof window !== "undefined") window.location.assign("/");
  }, [status]);

  return null;
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const authEnabled = useAuthEnabled();
  const { resolvedTheme } = useTheme();

  // Avoid hydration mismatches from client-only sources.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const logoSrc = mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  return (
    <div className="min-h-[100svh] w-full bg-[var(--bg)] text-[var(--fg)]">
      {authEnabled ? <AuthRedirector /> : null}

      <header className="sticky top-0 z-10 bg-[var(--bg)]">
        {/* Full-width header: logo pinned left, account menu pinned right. */}
        {/* Keep the logo + workspace pill identical to the app shell (desktop sidebar + mobile top bar). */}
        <div className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3 md:h-auto md:items-start md:border-b-0 md:px-4 md:pb-7 md:pt-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
              <Image src={logoSrc} alt="LinkDrop" width={32} height={32} priority />
            </Link>
            <ActiveWorkspacePill
              className="hidden sm:inline-flex"
              maxWidthClassName="max-w-[160px]"
              // TODO: wire to real subscription plan; temporary UI stub.
              planBadgeText="PRO"
              textClassName="text-[11px]"
            />
          </div>

          <div className="shrink-0">
            <AccountMenu variant="topbar" />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1280px] px-5 py-8">{children}</main>
    </div>
  );
}


