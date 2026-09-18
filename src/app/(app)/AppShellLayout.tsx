"use client";

/**
 * Client app shell layout for authenticated app routes.
 *
 * Provides responsive left sidebar + mobile drawer, handles auth-required redirects,
 * and wires "add file" actions into the pending-upload flow.
 */
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getSession, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import LeftSidebar from "@/components/LeftSidebar";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import IconButton from "@/components/ui/IconButton";
import Spinner from "@/components/ui/Spinner";
import { useAuthEnabled } from "@/app/providers";
import { usePendingUpload } from "@/lib/pendingUpload";

/**
 * Gate for the authenticated app shell: reveals `children` only once a session is confirmed.
 *
 * The previous version (`AuthRedirector`) rendered the protected shell immediately and redirected
 * from a `useEffect` after the fact — on a direct visit while signed out, the sidebar and page
 * content were visible for one paint before the redirect fired. Gating the render itself, not
 * just the redirect, is what removes that: nothing here renders until `status` resolves, and
 * nothing protected renders unless it resolves to `"authenticated"`.
 *
 * Redirects to `/login?next=<path>`, not `/`: landing on the marketing home page after being
 * bounced from a gated route reads as "nothing happened", not as an explanation, and `/login`
 * already says plainly that signing in is what's needed. Carrying `next` returns the user to the
 * page they wanted once they do.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { status } = useSession();

  /**
   * Confirm before bouncing.
   *
   * `useSession` reports `"unauthenticated"` for a *failed* session request as readily as for a
   * real signed-out visit, and that request fails whenever the server is briefly unreachable — a
   * dev restart, a deploy, a dropped connection, a laptop waking up. The first version redirected
   * on that status alone, so a blip logged people out of a page they were reading and sent them to
   * /login with a valid session still in the cookie. One re-check (a direct `getSession()`, not the
   * cached hook state) is enough to tell the two apart: a real signed-out visit answers `null`
   * again, a blip answers with the session and the reader stays where they were.
   */
  useEffect(() => {
    if (status !== "unauthenticated") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const confirmed = await getSession();
          if (cancelled) return;
          if (confirmed?.user) {
            // The blip is over and the hook is holding a stale "unauthenticated": re-render with
            // fresh data rather than sending a signed-in reader to /login.
            router.refresh();
            return;
          }
        } catch {
          // Still unreachable — treat as signed out, the same as before.
        }
        if (cancelled) return;
        const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
        router.replace(`/login${next}`);
      })();
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router, pathname, status]);

  if (status !== "authenticated") {
    return (
      <div className="grid h-[100svh] w-full place-items-center bg-[var(--bg)]">
        <Spinner className="h-6 w-6 text-[var(--muted)]" />
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Wraps app pages in a responsive shell with sidebar navigation.
 *
 * Side effects: prefetches dashboard routes (best-effort) and locks body scroll when the mobile
 * drawer is open. Certain routes (review) intentionally render full-width without sidebar.
 */
export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const authEnabled = useAuthEnabled();
  const { setPendingFile } = usePendingUpload();
  const { resolvedTheme } = useTheme();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Prefetch dashboard route chunks so clicking "Dashboard" from menus feels instant.
  // Many dashboard links live inside dropdowns (not mounted until click), which prevents
  // Next.js from prefetching by default.
  useEffect(() => {
    if (!authEnabled) return;
    try {
      router.prefetch("/dashboard");
      router.prefetch("/dashboard?tab=overview");
    } catch {
      // ignore (best-effort)
    }
  }, [authEnabled, router]);

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
  const hideSidebar = useMemo(() => pathname.includes("/review"), [pathname]);

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
    return authEnabled ? <AuthGate>{children}</AuthGate> : <>{children}</>;
  }

  const shell = (
    <div className="flex h-[100svh] w-full flex-col bg-[var(--bg)] text-[var(--fg)] md:flex-row">
      {/* Mobile top bar */}
      <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
            <Image src={logoSrc} alt="LinkDrop" width={28} height={28} priority className="block" />
          </Link>
          <ActiveWorkspacePill
            className="inline-flex"
            maxWidthClassName="max-w-[44vw] sm:max-w-[160px]"
            textClassName="text-[11px]"
          />
        </div>
        <IconButton
          ariaLabel={mobileSidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileSidebarOpen}
          className="h-10 w-10 bg-[var(--panel)] p-0 text-[var(--fg)]"
          onClick={() => setMobileSidebarOpen((v) => !v)}
        >
          {mobileSidebarOpen ? <XMarkIcon className="h-5 w-5" /> : <Bars3Icon className="h-5 w-5" />}
        </IconButton>
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
          <div className="absolute left-0 top-0 h-full w-[312px] shadow-xl">
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

  return authEnabled ? <AuthGate>{shell}</AuthGate> : shell;
}




