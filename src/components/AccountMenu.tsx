"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  ArrowRightOnRectangleIcon,
  ComputerDesktopIcon,
  MoonIcon,
  QuestionMarkCircleIcon,
  SunIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useTheme } from "next-themes";
import { useAuthEnabled, useNavigationLocked } from "@/app/providers";
import AboutCopy from "@/components/AboutCopy";
import Modal from "@/components/modals/Modal";

type MenuItem =
  | { type: "link"; label: string; href: string; icon?: React.ReactNode }
  | { type: "button"; label: string; onClick: () => void; icon?: React.ReactNode }
  | { type: "separator" }
  | { type: "disabled"; label: string; icon?: React.ReactNode; hint?: string };

function initials(nameOrEmail: string) {
  const s = nameOrEmail.trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

export default function AccountMenu() {
  const authEnabled = useAuthEnabled();
  if (!authEnabled) return <AccountMenuDisabled />;
  return <AccountMenuEnabled />;
}

function AccountMenuDisabled() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navLocked = useNavigationLocked();
  const isDark = (resolvedTheme ?? theme) === "dark";
  const logoSrc = isDark ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  const displayName = "Guest";
  const subLabel = "Auth disabled";

  const avatarUrl = null;

  const menuItems: MenuItem[] = useMemo(() => {
    return [
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
    if (!navLocked) return;
    const id = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(id);
  }, [navLocked]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={navLocked}
        aria-disabled={navLocked}
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--sidebar-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        onClick={() => {
          if (navLocked) return;
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <div className="grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-xs font-semibold text-[var(--fg)]">
          {avatarUrl ? (
            <Image src={avatarUrl} alt="" width={32} height={32} className="h-8 w-8 object-cover" />
          ) : (
            <UserCircleIcon className="h-6 w-6 text-[var(--muted-2)]" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{displayName}</div>
          <div className="truncate text-[11px] text-[var(--muted-2)]">{subLabel}</div>
        </div>
      </button>

      {open && !navLocked ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+10px)] left-0 w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
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

function AccountMenuEnabled() {
  const { data: session } = useSession();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navLocked = useNavigationLocked();
  const isDark = (resolvedTheme ?? theme) === "dark";
  const logoSrc = isDark ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

  const displayName = session?.user?.name?.trim() || (session?.user ? "Account" : "Guest");
  const subLabel = session?.user ? "Free" : "Not signed in";

  const avatarUrl = session?.user?.image ?? null;
  const avatarFallback = useMemo(() => initials(displayName), [displayName]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (!session?.user) {
      return [
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
            void signIn("google", { callbackUrl: "/" });
          },
        },
      ];
    }

    return [
      {
        type: "button",
        label: "About us",
        icon: <QuestionMarkCircleIcon className="h-4 w-4" />,
        onClick: () => setShowAboutModal(true),
      },
      { type: "separator" },
      {
        type: "button",
        label: "Log out",
        icon: <ArrowRightOnRectangleIcon className="h-4 w-4" />,
        onClick: () => void signOut({ callbackUrl: "/" }),
      },
    ];
  }, [session?.user, setShowAboutModal, loginBusy]);

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={navLocked}
        aria-disabled={navLocked}
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--sidebar-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        onClick={() => {
          if (navLocked) return;
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <div className="grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-xs font-semibold text-[var(--fg)]">
          {avatarUrl ? (
            <Image src={avatarUrl} alt="" width={32} height={32} className="h-8 w-8 object-cover" />
          ) : session?.user ? (
            <span aria-hidden="true">{avatarFallback}</span>
          ) : (
            <UserCircleIcon className="h-6 w-6 text-[var(--muted-2)]" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{displayName}</div>
          <div className="truncate text-[11px] text-[var(--muted-2)]">{subLabel}</div>
        </div>
      </button>

      {open && !navLocked ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+10px)] left-0 w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
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

