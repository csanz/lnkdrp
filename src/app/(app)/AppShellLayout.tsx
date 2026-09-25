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
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import LeftSidebar from "@/components/LeftSidebar";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import IconButton from "@/components/ui/IconButton";
import Spinner from "@/components/ui/Spinner";
import { useAuthEnabled } from "@/app/providers";
import { usePendingUpload } from "@/lib/pendingUpload";
import { hadSession, rememberSignedIn } from "@/lib/client/sessionMemory";

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
 *
 * When this browser had a session and no longer does, `signedOut=1` rides along and `/login` leads
 * with "You've been signed out" instead of a sign-up pitch — the difference between an explanation
 * and an unexplained bounce. A browser that was never signed in gets the plain page; see
 * `src/lib/client/sessionMemory.ts`.
 */
/** Confirmed sessions the hook has ignored before the gate offers a sign-in link instead of a spinner. */
const STUCK_AFTER_CONFIRMATIONS = 3;

function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { status, update } = useSession();

  /**
   * Confirm before bouncing — and never bounce on an answer we did not get.
   *
   * `useSession` reports `"unauthenticated"` for a *failed* session request as readily as for a
   * real signed-out visit. The first version redirected on that status alone, so a blip logged
   * people out of a page they were reading. The second re-checked with `getSession()` — which
   * does not help, and is why this kept happening: next-auth's fetch helper catches every network
   * error, logs `CLIENT_FETCH_ERROR` and returns `null` (node_modules/next-auth/src/client/_utils.ts),
   * and it also returns `null` for a 200 with an empty body. One value, three meanings: signed
   * out, request failed, server unreachable. The re-check answered `null` on a blip and the reader
   * was sent to /login exactly as before.
   *
   * So the session endpoint is read directly, where the HTTP status is visible:
   *
   * - **200 with a user** — the hook is holding a stale "unauthenticated"; re-render, stay put.
   * - **200 with `{}`** — a real signed-out visit, the only case that redirects.
   * - **anything else, or a thrown fetch** — we do not know. Retry, and keep waiting.
   *
   * "We do not know" never redirects. A signed-out visitor to a gated page gets their answer on
   * the first request that completes; a signed-in one whose network dropped keeps their page.
   */
  const [unreachable, setUnreachable] = useState(false);
  /**
   * The server keeps saying there is a session and the hook keeps saying there is not.
   *
   * `router.refresh()` re-renders server components; it does not touch next-auth's client state,
   * so a session recovered after a blip (the server answered 200 with a user) left `status` at
   * "unauthenticated" and this gate on its spinner for good. The hook is now told to refetch
   * (`update()`), and the check keeps polling until `status` flips. If it has not after a few
   * confirmations, the person gets a way out rather than a spinner.
   */
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (status !== "unauthenticated") return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    let confirmedSessions = 0;

    const goToLogin = () => {
      const query = new URLSearchParams();
      if (pathname && pathname !== "/") query.set("next", pathname);
      // Only claim they were signed out when they actually were.
      if (hadSession()) query.set("signedOut", "1");
      const suffix = query.toString();
      router.replace(`/login${suffix ? `?${suffix}` : ""}`);
    };

    const check = async () => {
      if (cancelled) return;
      // A laptop waking up, or a dropped connection: the answer is knowable later, never now.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setUnreachable(true);
        schedule();
        return;
      }
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) throw new Error(`session ${res.status}`);
        const json = (await res.json().catch(() => null)) as { user?: unknown } | null;
        if (cancelled) return;
        if (json && typeof json === "object" && json.user) {
          setUnreachable(false);
          confirmedSessions += 1;
          // Refetch the client session so `status` can flip, then re-render the server tree.
          try {
            await update();
          } catch {
            // The poll below asks again.
          }
          if (cancelled) return;
          router.refresh();
          if (confirmedSessions >= STUCK_AFTER_CONFIRMATIONS) setStuck(true);
          // Not done until `status` changes (which re-runs this effect and cancels this run).
          schedule();
          return;
        }
        // A clean answer: nobody is signed in here.
        goToLogin();
        return;
      } catch {
        if (cancelled) return;
        // No answer. Say so quietly and try again; do not assert anything about the session.
        setUnreachable(true);
        schedule();
      }
    };

    /** 1.2s, then backing off to 10s — long enough to outlast a deploy or a sleeping laptop. */
    const schedule = () => {
      const delay = Math.min(10_000, 1_200 * 2 ** attempt);
      attempt += 1;
      timer = window.setTimeout(() => void check(), delay);
    };

    // The first wait is what distinguishes a blip from a sign-out; it was always here.
    timer = window.setTimeout(() => void check(), 1_200);

    // Waking up or coming back online is the moment the answer becomes knowable — take it rather
    // than sitting out the current backoff.
    const retryNow = () => {
      if (cancelled) return;
      // `visibilitychange` fires on hide as well as show. Retrying on hide reset the backoff and
      // fired a request nobody was waiting for — and collapsed the 1.2s grace window that is the
      // whole mechanism for telling a blip from a sign-out.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      attempt = 0;
      void check();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", retryNow);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", retryNow);
    };
  }, [router, pathname, status, update]);

  // One bit, written while the session is known good, read only when it is gone.
  useEffect(() => {
    if (status === "authenticated") rememberSignedIn();
  }, [status]);

  if (status !== "authenticated") {
    const loginHref = `/login?next=${encodeURIComponent(pathname || "/")}`;
    return (
      <div className="grid h-[100svh] w-full place-items-center gap-3 bg-[var(--bg)]">
        <Spinner className="h-6 w-6 text-[var(--muted)]" />
        {/* Only once a request has actually failed: a spinner that explains itself after a few
            seconds is reassuring, one that explains itself immediately is alarming. */}
        {stuck ? (
          <div className="text-center text-[13px] text-[var(--muted)]">
            Still signing you in.{" "}
            <Link href={loginHref} className="font-medium text-[var(--fg)] underline underline-offset-4">
              Sign in again
            </Link>
          </div>
        ) : unreachable ? (
          <div className="text-center text-[13px] text-[var(--muted)]">
            Can&apos;t reach the server. Retrying&hellip;
          </div>
        ) : null}
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




