"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { PendingUploadProvider } from "@/lib/pendingUpload";
import { clearTempUser, getTempUser } from "@/lib/gating/tempUserClient";
import { fetchJson } from "@/lib/http/fetchJson";

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
          <PendingUploadProvider>
            <NavigationLockProvider>{children}</NavigationLockProvider>
          </PendingUploadProvider>
        </AuthEnabledContext.Provider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
      <AuthEnabledContext.Provider value>
        <SessionProvider>
          <TempUserClaimOnLogin />
          <PendingUploadProvider>
            <NavigationLockProvider>{children}</NavigationLockProvider>
          </PendingUploadProvider>
        </SessionProvider>
      </AuthEnabledContext.Provider>
    </ThemeProvider>
  );
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



