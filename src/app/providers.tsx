"use client";

import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { usePathname, useSearchParams } from "next/navigation";
import { PendingUploadProvider } from "@/lib/pendingUpload";
import { clearTempUser, getTempUser } from "@/lib/gating/tempUserClient";
import { fetchJson } from "@/lib/http/fetchJson";
import { trackPageTiming } from "@/lib/metrics/client";
import { clearSidebarCache, refreshSidebarCache, setActiveOrgIdForCaches } from "@/lib/sidebarCache";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";
import OutOfCreditsListener from "@/components/OutOfCreditsListener";

const AuthEnabledContext = createContext(false);
export function useAuthEnabled() {
  return useContext(AuthEnabledContext);
}

type NavigationLockContextValue = {
  acquire: () => () => void;
  locked: boolean;
};

const NavigationLockContext = createContext<NavigationLockContextValue | null>(null);
function isLinkLikeTarget(target: EventTarget | null) {
  if (!target) return false;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("a,[role='link']"));
}
function NavigationLockProvider({ children }: { children: React.ReactNode }) {
  const [lockCount, setLockCount] = useState(0);
  const locked = lockCount > 0;
  const nextIdRef = useRef(1);
  const heldIdsRef = useRef<Set<number>>(new Set());

  const acquire = useCallback(() => {
    const id = nextIdRef.current++;
    heldIdsRef.current.add(id);
    setLockCount((c) => c + 1);
    return () => {
      if (!heldIdsRef.current.has(id)) return;
      heldIdsRef.current.delete(id);
      setLockCount((c) => Math.max(0, c - 1));
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.navLocked = locked ? "true" : "false";
    return () => {
      // Ensure we don't leave the flag behind during hot reloads / transitions.
      document.documentElement.dataset.navLocked = "false";
    };
  }, [locked]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onClickCapture = (e: MouseEvent) => {
      if (!locked) return;
      if (!isLinkLikeTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (!locked) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!isLinkLikeTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [locked]);

  const value = useMemo<NavigationLockContextValue>(() => ({ acquire, locked }), [acquire, locked]);

  return (
    <NavigationLockContext.Provider value={value}>{children}</NavigationLockContext.Provider>
  );
}

/**
 * Lock *all* link-style navigation (`<a>` and `[role="link"]`) while `shouldLock` is true.
 * Uses a reference-counted lock to avoid accidental unlocks if multiple operations overlap.
 */
export function useNavigationLockWhile(shouldLock: boolean) {
  const ctx = useContext(NavigationLockContext);
  if (!ctx) throw new Error("useNavigationLockWhile must be used within NavigationLockProvider");

  useEffect(() => {
    if (!shouldLock) return;
    const release = ctx.acquire();
    return () => release();
  }, [ctx, shouldLock]);
}
export function useNavigationLocked() {
  const ctx = useContext(NavigationLockContext);
  if (!ctx) throw new Error("useNavigationLocked must be used within NavigationLockProvider");
  return ctx.locked;
}
export default function Providers({
  children,
  enableAuth = false,
}: {
  children: React.ReactNode;
  enableAuth?: boolean;
}) {
  if (!enableAuth) {
    return (
      <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
        <AuthEnabledContext.Provider value={false}>
          <Suspense fallback={null}>
            <SessionPageTimingTracker />
          </Suspense>
          <PendingUploadProvider>
            <NavigationLockProvider>
              {children}
              <OutOfCreditsListener />
            </NavigationLockProvider>
          </PendingUploadProvider>
        </AuthEnabledContext.Provider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
      <AuthEnabledContext.Provider value>
        <SessionProvider>
          <AuthTransitionClearOnAuth />
          <ActiveOrgCacheSync />
          <TempUserClaimOnLogin />
          <OrgJoinClaimOnLogin />
          <Suspense fallback={null}>
            <SessionPageTimingTracker />
          </Suspense>
          <PendingUploadProvider>
            <NavigationLockProvider>
              {children}
              <OutOfCreditsListener />
            </NavigationLockProvider>
          </PendingUploadProvider>
        </SessionProvider>
      </AuthEnabledContext.Provider>
    </ThemeProvider>
  );
}
function SessionPageTimingTracker() {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const prevRef = useRef<{ path: string; enteredAtMs: number; referrer: string | null } | null>(null);

  const fullPath = useMemo(() => {
    const q = searchParams?.toString?.() ?? "";
    return q ? `${pathname}?${q}` : pathname;
  }, [pathname, searchParams]);

  useEffect(() => {
    const now = Date.now();

    // Flush previous page (if any) on navigation.
    if (prevRef.current) {
      const prev = prevRef.current;
      trackPageTiming({
        path: prev.path,
        referrer: prev.referrer,
        enteredAtMs: prev.enteredAtMs,
        leftAtMs: now,
      });
    }

    const referrer =
      prevRef.current?.path ??
      (typeof document !== "undefined" && typeof document.referrer === "string" && document.referrer
        ? document.referrer
        : null);

    prevRef.current = { path: fullPath, enteredAtMs: now, referrer };
  }, [fullPath]);

  useEffect(() => {
    function flush() {
      const cur = prevRef.current;
      if (!cur) return;
      const now = Date.now();
      trackPageTiming({ path: cur.path, referrer: cur.referrer, enteredAtMs: cur.enteredAtMs, leftAtMs: now });
      // Prevent double-flush on multiple events.
      prevRef.current = { ...cur, enteredAtMs: now, referrer: cur.path };
    }
    function onVisChange() {
      if (document.visibilityState === "hidden") flush();
    }

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  return null;
}
function TempUserClaimOnLogin() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;
    const temp = getTempUser();
    if (!temp) return;

    let cancelled = false;
    void (async () => {
      try {
        await fetchJson("/api/auth/claim-temp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tempUserId: temp.id, tempUserSecret: temp.secret }),
        });
        if (!cancelled) clearTempUser();
      } catch {
        // keep temp user; user can retry by refreshing
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status]);

  return null;
}

/**
 * Keep client caches scoped to the current active org by syncing a stable org id into localStorage.
 */
function ActiveOrgCacheSync() {
  const { status, data: session } = useSession();
  const prevRef = useRef<string | null>(null);
  useEffect(() => {
    // Important: NextAuth starts in a transient "loading" state on page loads/navigation.
    // Do NOT clear the active org cache key during this phase, otherwise client caches
    // (sidebar/starred/etc.) cannot read from localStorage and the sidebar appears empty
    // until `/api/orgs/active` resolves.
    if (status === "loading") return;
    if (status !== "authenticated") {
      setActiveOrgIdForCaches(null);
      prevRef.current = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Source of truth: server-side active-org cookie (ensures API scoping matches the UI).
        const json = await fetchJson<{ activeOrgId?: string }>("/api/orgs/active", {
          cache: "no-store",
          credentials: "include",
        });
        const serverOrgId = typeof json?.activeOrgId === "string" ? json.activeOrgId : null;
        if (cancelled) return;
        const next = typeof serverOrgId === "string" ? serverOrgId : null;
        const prev = prevRef.current;
        setActiveOrgIdForCaches(next);
        // If org context changed (or was previously unknown), clear in-memory cache and force refresh.
        if (next && next !== prev) {
          clearSidebarCache({ memoryOnly: true });
          await refreshSidebarCache({ force: true, reason: "active-org-sync" });
        } else if (next && !prev) {
          await refreshSidebarCache({ force: true, reason: "active-org-sync" });
        }
        prevRef.current = next;
      } catch {
        // Fall back to session field (best-effort).
        const raw =
          (session?.user as { activeOrgId?: unknown } | undefined)?.activeOrgId ??
          (session as { activeOrgId?: unknown } | undefined)?.activeOrgId;
        const next = typeof raw === "string" ? raw : null;
        if (!cancelled) {
          const prev = prevRef.current;
          setActiveOrgIdForCaches(next);
          if (next && next !== prev) {
            clearSidebarCache({ memoryOnly: true });
            await refreshSidebarCache({ force: true, reason: "active-org-sync-fallback" });
          }
          prevRef.current = next;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, session]);
  return null;
}

/**
 * On successful login, attempt to claim an org join cookie (best-effort).
 *
 * Used for the flow: "create org → re-auth as another account → auto-join".
 */
function OrgJoinClaimOnLogin() {
  const { status, data: session, update } = useSession();
  async function doSwitch(orgId: string) {
    const returnTo =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
        : "/";
    await switchWorkspaceWithOverlay({ orgId, returnTo });
  }

  useEffect(() => {
    if (status !== "authenticated") return;
    if (!session?.user?.id) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ claimed?: boolean; orgId?: string }>("/api/orgs/claim-join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const orgId = typeof res?.orgId === "string" ? res.orgId : "";
        if (!orgId || !res?.claimed) return;
        if (cancelled) return;

        // Switch via server redirect route (sets httpOnly cookie reliably).
        setActiveOrgIdForCaches(orgId);
        clearSidebarCache({ memoryOnly: true });
        // Best-effort update for UI; the server cookie is the source of truth.
        await update({ user: { ...(session.user ?? {}), activeOrgId: orgId } });
        if (typeof window !== "undefined") {
          try {
            await doSwitch(orgId);
          } catch {
            window.location.assign(`/org/switch?orgId=${encodeURIComponent(orgId)}`);
          }
        } else {
          await refreshSidebarCache({ force: true, reason: "org-join-claim" });
        }
      } catch {
        // ignore (best-effort)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, session?.user?.id, update, session?.user]);

  return null;
}

/**
 * Clear the "auth transition" marker once we're authenticated again.
 * This prevents an old marker from affecting future logged-out sessions.
 */
function AuthTransitionClearOnAuth() {
  const { status } = useSession();
  useEffect(() => {
    if (status !== "authenticated") return;
    try {
      sessionStorage.removeItem("ld_auth_transition");
    } catch {
      // ignore
    }
  }, [status]);
  return null;
}
