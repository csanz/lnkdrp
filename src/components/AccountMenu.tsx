"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  ArrowRightOnRectangleIcon,
  ComputerDesktopIcon,
  Cog6ToothIcon,
  MoonIcon,
  QuestionMarkCircleIcon,
  SunIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useTheme } from "next-themes";
import { useAuthEnabled, useNavigationLocked } from "@/app/providers";
import AboutCopy from "@/components/AboutCopy";
import Modal from "@/components/modals/Modal";
import IconLink from "@/components/ui/IconLink";
import {
  ORGS_CACHE_UPDATED_EVENT,
  readOrgsCacheSnapshot,
  refreshOrgsCache,
  setCachedActiveOrgId,
} from "@/lib/orgsCache";
import { clearSidebarCache, setActiveOrgIdForCaches } from "@/lib/sidebarCache";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";

type MenuItem =
  | { type: "link"; label: string; href: string; icon?: React.ReactNode }
  | { type: "button"; label: string; onClick: () => void; icon?: React.ReactNode }
  | { type: "separator" }
  | { type: "disabled"; label: string; icon?: React.ReactNode; hint?: string };
/**
 * Initials (uses trim, filter, split).
 */

const OPEN_ACCOUNT_MENU_AFTER_AUTH_KEY = "ld_open_account_menu_after_auth";

function initials(nameOrEmail: string) {
  const s = nameOrEmail.trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

function OrgAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string | null }) {
  const fallback = initials(name || "Org");
  return (
    <div className="grid h-6 w-6 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-[11px] font-semibold text-[var(--fg)]">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-6 w-6 object-cover" />
      ) : (
        <span aria-hidden="true">{fallback}</span>
      )}
    </div>
  );
}
/**
 * Render the AccountMenu UI.
 */


export default function AccountMenu({ variant }: { variant?: "sidebar" | "topbar" }) {
  const authEnabled = useAuthEnabled();
  if (!authEnabled) return <AccountMenuDisabled variant={variant} />;
  return <AccountMenuEnabled variant={variant} />;
}
/**
 * Render the AccountMenuDisabled UI (uses effects, memoized values, local state).
 */


function AccountMenuDisabled({ variant }: { variant?: "sidebar" | "topbar" }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navLocked = useNavigationLocked();
  // Avoid hydration mismatch: theme can differ between SSR and the first client render.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const isDark = mounted && (resolvedTheme ?? theme) === "dark";
  const logoSrc = isDark ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  const displayName = "Guest";
  const subLabel = "Auth disabled";

  const avatarUrl = null;

  const menuItems: MenuItem[] = useMemo(() => {
    return [
      { type: "link", label: "Dashboard", href: "/dashboard", icon: <Cog6ToothIcon className="h-4 w-4" /> },
      {
        type: "button",
        label: "About us",
        icon: <QuestionMarkCircleIcon className="h-4 w-4" />,
        onClick: () => setShowAboutModal(true),
      },
      { type: "separator" },
      { type: "link", label: "Log in", href: "/login", icon: <ArrowRightOnRectangleIcon className="h-4 w-4" /> },
    ];
  }, [setShowAboutModal]);

  useEffect(() => {
    if (!open) return;
/**
 * Handle key down events; updates state (setOpen); uses setOpen.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
/**
 * Handle pointer down events; updates state (setOpen); uses contains, setOpen.
 */

    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!navLocked) return;
    const id = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(id);
  }, [navLocked]);

  const isTopbar = variant === "topbar";
  const avatarFallback = useMemo(() => initials(displayName), []);

  return (
    <div ref={rootRef} className={isTopbar ? "relative" : "relative group"}>
      <button
        type="button"
        disabled={navLocked}
        aria-disabled={navLocked}
        className={
          isTopbar
            ? "inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            : "flex w-full items-center gap-3 rounded-xl px-2 py-2 pr-9 text-left hover:bg-[var(--sidebar-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        }
        onClick={() => {
          if (navLocked) return;
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <div
          className={
            isTopbar
              ? "grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)]"
              : "grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-xs font-semibold text-[var(--fg)]"
          }
        >
          {avatarUrl ? (
            <Image src={avatarUrl} alt="" width={32} height={32} className="h-8 w-8 object-cover" />
          ) : (
            <span className="text-xs font-semibold text-[var(--fg)]" aria-hidden="true">
              {avatarFallback}
            </span>
          )}
        </div>
        {!isTopbar ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{displayName}</div>
            <div className="truncate text-[11px] text-[var(--muted-2)]">{subLabel}</div>
          </div>
        ) : null}
      </button>

      {!isTopbar ? (
        <IconLink
          href="/dashboard"
          ariaLabel="Dashboard"
          title="Dashboard"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            // Keep existing behavior: clicking the account section opens the menu,
            // but clicking the gear should navigate instead.
            e.stopPropagation();
          }}
          className={[
            "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1",
            "text-[var(--muted-2)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]",
            navLocked
              ? "opacity-0 group-hover:opacity-50 pointer-events-none"
              : "opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto",
          ].join(" ")}
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </IconLink>
      ) : null}

      {open && !navLocked ? (
        <div
          role="menu"
          className={
            isTopbar
              ? "absolute right-0 top-[calc(100%+10px)] z-[200] w-[min(240px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_14px_40px_rgba(0,0,0,0.35)]"
              : "absolute bottom-[calc(100%+18px)] left-0 z-[200] w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_14px_40px_rgba(0,0,0,0.35)]"
          }
        >
          <div className="px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              Theme
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <ThemeChoice
                label="System"
                icon={<ComputerDesktopIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "system"}
                onClick={() => setTheme("system")}
              />
              <ThemeChoice
                label="Light"
                icon={<SunIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "light"}
                onClick={() => setTheme("light")}
              />
              <ThemeChoice
                label="Dark"
                icon={<MoonIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "dark"}
                onClick={() => setTheme("dark")}
              />
            </div>
          </div>
          <ul className="py-1">
            {menuItems.map((item, idx) => {
              if (item.type === "separator") {
                return <li key={`sep-${idx}`} className="my-1 h-px bg-[var(--border)]" />;
              }

              const base =
                "flex w-full items-center gap-2 px-3 py-2 text-[13px] text-[var(--fg)] hover:bg-[var(--panel-hover)] active:bg-[var(--panel-hover)]";

              if (item.type === "disabled") {
                return (
                  <li key={`${item.label}-${idx}`}>
                    <div
                      className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-[13px] text-[var(--muted-2)]"
                      title={item.hint}
                      aria-disabled="true"
                    >
                      <span className="text-[var(--muted-2)]">{item.icon}</span>
                      <span>{item.label}</span>
                    </div>
                  </li>
                );
              }

              if (item.type === "link") {
                return (
                  <li key={`${item.href}-${idx}`}>
                    <Link
                      href={item.href}
                      className={base}
                      role="menuitem"
                      onClick={() => setOpen(false)}
                    >
                      <span className="text-[var(--muted-2)]">{item.icon}</span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              }

              return (
                <li key={`${item.label}-${idx}`}>
                  <button
                    type="button"
                    className={base}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      item.onClick();
                    }}
                  >
                    <span className="text-[var(--muted-2)]">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Modal open={showAboutModal} onClose={() => setShowAboutModal(false)} ariaLabel="About us">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]">
            <Image src={logoSrc} alt="" width={18} height={18} />
          </div>
          <div className="text-base font-semibold text-[var(--fg)]">About us</div>
        </div>
        <div className="mt-3">
          <AboutCopy />
        </div>
      </Modal>
    </div>
  );
}
/**
 * Render the AccountMenuEnabled UI (uses effects, memoized values, local state).
 */


function AccountMenuEnabled({ variant }: { variant?: "sidebar" | "topbar" }) {
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navLocked = useNavigationLocked();
  const isTopbar = variant === "topbar";
  const [orgsBusy, setOrgsBusy] = useState(false);
  const [orgActionBusy, setOrgActionBusy] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; type: string; role: string; avatarUrl?: string | null }>>([]);
  const [serverActiveOrgId, setServerActiveOrgId] = useState<string | null>(null);

  // Avoid hydration mismatch: theme can differ between SSR and the first client render.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const isDark = mounted && (resolvedTheme ?? theme) === "dark";
  const logoSrc = isDark ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  const displayName = session?.user?.name?.trim() || (session?.user ? "Account" : "Guest");
  const subLabel = session?.user ? (session.user.email ?? "Signed in") : "Not signed in";
  const avatarFallback = useMemo(() => initials(displayName), [displayName]);

  const activeOrgId = serverActiveOrgId ?? ((session as any)?.activeOrgId ?? null);
  const stableOrgs = useMemo(() => {
    const rows = Array.isArray(orgs) ? [...orgs] : [];
    rows.sort((a, b) => {
      const aPersonal = a.type === "personal";
      const bPersonal = b.type === "personal";
      if (aPersonal && !bPersonal) return -1;
      if (bPersonal && !aPersonal) return 1;
      const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
      if (byName) return byName;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
    return rows;
  }, [orgs]);

  const currentOrg = useMemo(() => {
    if (!activeOrgId) return null;
    return stableOrgs.find((o) => o.id === activeOrgId) ?? null;
  }, [activeOrgId, stableOrgs]);

  const quickOrgs = useMemo(() => {
    // Keep a stable order; don't jump the active org to the top (it feels jarring in the menu).
    return stableOrgs.slice(0, 4);
  }, [stableOrgs]);

  // If we kicked off OAuth from this menu, reopen it after returning.
  useEffect(() => {
    if (!session?.user) return;
    if (navLocked) return;
    try {
      const v = sessionStorage.getItem(OPEN_ACCOUNT_MENU_AFTER_AUTH_KEY) ?? "";
      if (!v) return;
      sessionStorage.removeItem(OPEN_ACCOUNT_MENU_AFTER_AUTH_KEY);
      setOpen(true);
    } catch {
      // ignore
    }
  }, [session?.user, navLocked]);

  // Load org list for workspace quick switch (best-effort cache + background refresh).
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    const userKey = session.user.email ?? "";

    const cached = readOrgsCacheSnapshot(userKey);
    if (cached) {
      setOrgs(Array.isArray(cached.orgs) ? cached.orgs : []);
      setServerActiveOrgId(typeof cached.activeOrgId === "string" ? cached.activeOrgId : null);
      setOrgsError(null);
    } else {
      setOrgsBusy(true);
      setOrgsError(null);
    }

    void (async () => {
      try {
        const snap = await refreshOrgsCache({ userKey, force: true });
        if (cancelled) return;
        if (snap) {
          setOrgs(Array.isArray(snap.orgs) ? snap.orgs : []);
          setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
          setOrgsError(null);
        }
      } catch (e) {
        if (cancelled) return;
        if (!cached) {
          setOrgs([]);
          setOrgsError(e instanceof Error ? e.message : "Failed to load workspaces");
          setServerActiveOrgId(null);
        }
      } finally {
        if (!cancelled) setOrgsBusy(false);
      }
    })();

    function onCacheUpdated() {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      setOrgs(Array.isArray(snap.orgs) ? snap.orgs : []);
      setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
    }

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
    };
  }, [session?.user]);

  async function switchOrg(nextOrgId: string) {
    if (!nextOrgId) return;
    if (!session?.user) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    if (activeOrgId && nextOrgId === activeOrgId) return;
    setOrgActionBusy(true);
    try {
      setCachedActiveOrgId(nextOrgId, session.user.email ?? "");
      setActiveOrgIdForCaches(nextOrgId);
      clearSidebarCache({ memoryOnly: true });
      if (typeof window !== "undefined") {
        const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        try {
          await switchWorkspaceWithOverlay({ orgId: nextOrgId, returnTo });
        } catch {
          window.location.assign(
            `/org/switch?orgId=${encodeURIComponent(nextOrgId)}&returnTo=${encodeURIComponent(returnTo)}`,
          );
        }
      }
    } finally {
      setOrgActionBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setLoginBusy(false);
  }, [open]);

  useEffect(() => {
    if (!navLocked) return;
    const id = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(id);
  }, [navLocked]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (!session?.user) {
      return [
        { type: "link", label: "Dashboard", href: "/dashboard", icon: <Cog6ToothIcon className="h-4 w-4" /> },
        { type: "separator" },
        {
          type: "button",
          label: "About us",
          icon: <QuestionMarkCircleIcon className="h-4 w-4" />,
          onClick: () => setShowAboutModal(true),
        },
        { type: "separator" },
        {
          type: "button",
          label: loginBusy ? "Logging in…" : "Log in",
          icon: <ArrowRightOnRectangleIcon className="h-4 w-4" />,
          onClick: () => {
            if (loginBusy) return;
            setLoginBusy(true);
            try {
              sessionStorage.setItem(OPEN_ACCOUNT_MENU_AFTER_AUTH_KEY, "1");
            } catch {
              // ignore
            }
            void signIn("google", { callbackUrl: "/" });
          },
        },
      ];
    }

    return [
      { type: "link", label: "Dashboard", href: "/dashboard", icon: <Cog6ToothIcon className="h-4 w-4" /> },
      {
        type: "button",
        label: "About us",
        icon: <QuestionMarkCircleIcon className="h-4 w-4" />,
        onClick: () => setShowAboutModal(true),
      },
      { type: "separator" },
      {
        type: "button",
        label: "Switch Google account…",
        icon: <UserCircleIcon className="h-4 w-4" />,
        onClick: () => {
          try {
            const payload = JSON.stringify({ kind: "switch-account", at: Date.now() });
            sessionStorage.setItem("ld_auth_transition", payload);
            document.cookie = `ld_auth_transition=${encodeURIComponent("switch-account")}; path=/; max-age=30; samesite=lax`;
            sessionStorage.setItem(OPEN_ACCOUNT_MENU_AFTER_AUTH_KEY, "1");
          } catch {
            // ignore
          }
          setOpen(false);
          void (async () => {
            await signOut({ redirect: false });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void signIn("google", { callbackUrl: "/" }, { prompt: "select_account" } as any);
          })();
        },
      },
      {
        type: "button",
        label: "Log out",
        icon: <ArrowRightOnRectangleIcon className="h-4 w-4" />,
        onClick: () => void signOut({ callbackUrl: "/" }),
      },
    ];
  }, [session?.user, loginBusy]);

  return (
    <div ref={rootRef} className={isTopbar ? "relative" : "relative group"}>
      <button
        type="button"
        disabled={navLocked}
        aria-disabled={navLocked}
        className={
          isTopbar
            ? "inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            : "flex w-full items-center gap-3 rounded-xl px-2 py-2 pr-9 text-left hover:bg-[var(--sidebar-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        }
        onClick={() => {
          if (navLocked) return;
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <div className="grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-xs font-semibold text-[var(--fg)]">
          {session?.user ? (
            <span aria-hidden="true">{avatarFallback}</span>
          ) : (
            <UserCircleIcon className="h-6 w-6 text-[var(--muted-2)]" aria-hidden="true" />
          )}
        </div>
        {!isTopbar ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{displayName}</div>
            <div className="truncate text-[11px] text-[var(--muted-2)]">{subLabel}</div>
          </div>
        ) : null}
      </button>

      {!isTopbar ? (
        <IconLink
          href="/dashboard"
          ariaLabel="Dashboard"
          title="Dashboard"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            // Keep existing behavior: clicking the account section opens the menu,
            // but clicking the gear should navigate instead.
            e.stopPropagation();
            setOpen(false);
          }}
          className={[
            "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1",
            "text-[var(--muted-2)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]",
            navLocked
              ? "opacity-0 group-hover:opacity-50 pointer-events-none"
              : "opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto",
          ].join(" ")}
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </IconLink>
      ) : null}

      {open && !navLocked ? (
        <div
          role="menu"
          className={
            isTopbar
              ? "absolute right-0 top-[calc(100%+10px)] z-[200] w-[min(240px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_14px_40px_rgba(0,0,0,0.35)]"
              : "absolute bottom-[calc(100%+18px)] left-0 z-[200] w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_14px_40px_rgba(0,0,0,0.35)]"
          }
        >
          {/* Workspace quick switch (keep lightweight; full management lives in Dashboard). */}
          {session?.user ? (
            <div className="px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                Workspace
              </div>
              <div className="mt-2 space-y-1">
                {orgsBusy ? (
                  <div className="px-2 py-1 text-[12px] text-[var(--muted-2)]">Loading…</div>
                ) : orgsError ? (
                  <div className="px-2 py-1 text-[12px] text-[var(--muted-2)]">{orgsError}</div>
                ) : quickOrgs.length ? (
                  <>
                    {quickOrgs.map((o) => {
                      const isActive = Boolean(activeOrgId && o.id === activeOrgId);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          disabled={navLocked || orgActionBusy || isActive}
                          className={[
                            "flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-[13px]",
                            isActive ? "bg-[var(--panel-hover)]" : "text-[var(--fg)] hover:bg-[var(--panel-hover)]",
                            navLocked || orgActionBusy ? "opacity-60" : "",
                          ].join(" ")}
                          onClick={() => {
                            if (isActive) return;
                            void switchOrg(o.id);
                            setOpen(false);
                          }}
                          title={o.role}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <OrgAvatar name={o.name} avatarUrl={typeof o.avatarUrl === "string" ? o.avatarUrl : null} />
                            <span className="truncate">{o.name}</span>
                          </span>
                          <span className="ml-2 text-[11px] text-[var(--muted-2)]">
                            {isActive ? "Active" : o.type === "personal" ? "Personal" : "Org"}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="mt-2 w-full rounded-lg border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                      disabled={navLocked}
                      onClick={() => {
                        setOpen(false);
                        router.push("/dashboard?tab=workspace", { scroll: false });
                      }}
                    >
                      Manage workspaces…
                    </button>
                  </>
                ) : (
                  <div className="px-2 py-1 text-[12px] text-[var(--muted-2)]">No workspaces</div>
                )}
              </div>
            </div>
          ) : null}

          <div className="my-1 h-px bg-[var(--border)]" />

          {session?.user?.email ? (
            <div className="px-3 py-2 text-[11px] text-[var(--muted-2)]">Signed in as: {session.user.email}</div>
          ) : null}

          <div className="px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">Theme</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <ThemeChoice
                label="System"
                icon={<ComputerDesktopIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "system"}
                onClick={() => setTheme("system")}
              />
              <ThemeChoice
                label="Light"
                icon={<SunIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "light"}
                onClick={() => setTheme("light")}
              />
              <ThemeChoice
                label="Dark"
                icon={<MoonIcon className="h-4 w-4" />}
                active={(theme ?? "system") === "dark"}
                onClick={() => setTheme("dark")}
              />
            </div>
          </div>

          <ul className="py-1">
            {menuItems.map((item, idx) => {
              if (item.type === "separator") {
                return <li key={`sep-${idx}`} className="my-1 h-px bg-[var(--border)]" />;
              }
              const base =
                "flex w-full items-center gap-2 px-3 py-2 text-[13px] text-[var(--fg)] hover:bg-[var(--panel-hover)] active:bg-[var(--panel-hover)]";

              if (item.type === "disabled") {
                return (
                  <li key={`${item.label}-${idx}`}>
                    <div
                      className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-[13px] text-[var(--muted-2)]"
                      title={item.hint}
                      aria-disabled="true"
                    >
                      <span className="text-[var(--muted-2)]">{item.icon}</span>
                      <span>{item.label}</span>
                    </div>
                  </li>
                );
              }

              if (item.type === "link") {
                return (
                  <li key={`${item.href}-${idx}`}>
                    <Link href={item.href} className={base} role="menuitem" onClick={() => setOpen(false)}>
                      <span className="text-[var(--muted-2)]">{item.icon}</span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              }

              return (
                <li key={`${item.label}-${idx}`}>
                  <button
                    type="button"
                    className={base}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      item.onClick();
                    }}
                  >
                    <span className="text-[var(--muted-2)]">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Modal open={showAboutModal} onClose={() => setShowAboutModal(false)} ariaLabel="About us">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]">
            <Image src={logoSrc} alt="" width={18} height={18} />
          </div>
          <div className="text-base font-semibold text-[var(--fg)]">About us</div>
        </div>
        <div className="mt-3">
          <AboutCopy />
        </div>
      </Modal>
    </div>
  );
}
/**
 * Render the ThemeChoice UI.
 */


function ThemeChoice({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center justify-center rounded-lg border px-2 py-2",
        active
          ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
          : "border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
      ].join(" ")}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <span className="text-[var(--muted-2)]">{icon}</span>
    </button>
  );
}

