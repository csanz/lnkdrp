"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import LeftSidebar from "@/components/LeftSidebar";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import { useAuthEnabled } from "@/app/providers";
import { usePendingUpload } from "@/lib/pendingUpload";

function AuthRedirector() {
  const router = useRouter();
  const { status } = useSession();

  useEffect(() => {
    if (status !== "unauthenticated") return;
    router.replace("/");
  }, [router, status]);

  return null;
}

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const authEnabled = useAuthEnabled();
  const { setPendingFile } = usePendingUpload();
  const { resolvedTheme } = useTheme();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Avoid hydration mismatches from client-only sources.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const logoSrc = mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  // Keep `/doc/:id/review` full-width (no sidebar), matching previous behavior.
  const hideSidebar = useMemo(
    () => pathname.includes("/review") || pathname.startsWith("/invitecodes"),
    [pathname],
  );

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Prevent background scroll when the mobile drawer is open.
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileSidebarOpen]);

  // Close on Escape when open.
  useEffect(() => {
    if (!mobileSidebarOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileSidebarOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  if (hideSidebar) {
    return (
      <>
        {authEnabled ? <AuthRedirector /> : null}
        {children}
      </>
    );
  }

  return (
    <div className="flex h-[100svh] w-full flex-col bg-[var(--bg)] text-[var(--fg)] md:flex-row">
      {authEnabled ? <AuthRedirector /> : null}

      {/* Mobile top bar */}
      <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
            <Image src={logoSrc} alt="LinkDrop" width={32} height={32} priority />
          </Link>
          <ActiveWorkspacePill
            className="hidden sm:inline-flex"
            maxWidthClassName="max-w-[160px]"
            textClassName="text-[11px]"
          />
        </div>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] hover:bg-[var(--panel-hover)]"
          aria-label={mobileSidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen((v) => !v)}
        >
          {mobileSidebarOpen ? <XMarkIcon className="h-5 w-5" /> : <Bars3Icon className="h-5 w-5" />}
        </button>
      </header>

      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <LeftSidebar
          onAddNewFile={(file) => {
            setPendingFile(file);
            router.push("/");
          }}
        />
      </div>

      {/* Mobile drawer */}
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[280px] shadow-xl">
            <LeftSidebar
              onAddNewFile={(file) => {
                setPendingFile(file);
                router.push("/");
              }}
            />
          </div>
        </div>
      ) : null}

      <main className="min-h-0 min-w-0 flex-1">{children}</main>
    </div>
  );
}




