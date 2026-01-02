"use client";

import AdminLeftSidebar from "@/components/AdminLeftSidebar";
import Image from "next/image";
import Link from "next/link";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
/**
 * Render the AdminShellLayout UI (uses effects, local state).
 */


export default function AdminShellLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
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
/**
 * Handle key down events; updates state (setMobileSidebarOpen); uses setMobileSidebarOpen.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileSidebarOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-[100svh] w-full flex-col bg-[var(--bg)] text-[var(--fg)] md:flex-row">
      {/* Mobile top bar */}
      <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3 md:hidden">
        <Link href="/a" className="inline-flex items-center gap-2" aria-label="Admin home">
          <Image src={logoSrc} alt="LinkDrop" width={28} height={28} priority />
        </Link>
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
        <AdminLeftSidebar />
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
            <AdminLeftSidebar />
          </div>
        </div>
      ) : null}

      <main className="min-h-0 min-w-0 flex-1">{children}</main>
    </div>
  );
}


