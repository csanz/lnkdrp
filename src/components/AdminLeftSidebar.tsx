"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useMemo, useSyncExternalStore } from "react";
import AccountMenu from "@/components/AccountMenu";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

type NavItem = { label: string; href: string; exact?: boolean };
type NavSection = { label: string; items: NavItem[] };
/**
 * Render the AdminLeftSidebar UI (uses memoized values).
 */


export default function AdminLeftSidebar() {
  const pathname = usePathname() ?? "";
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

  const sections: NavSection[] = useMemo(
    () => [
      { label: "Home", items: [{ label: "Home", href: "/a", exact: true }] },
      { label: "Users", items: [{ label: "Invites", href: "/a/invitecodes", exact: true }] },
      { label: "Metrics", items: [{ label: "Share views", href: "/a/shareviews", exact: false }] },
      { label: "AI", items: [{ label: "Runs", href: "/a/ai-runs", exact: true }] },
      { label: "Billing", items: [{ label: "Credits", href: "/a/credits", exact: true }] },
      {
        label: "Data",
        items: [
          { label: "Workspaces", href: "/a/data/workspaces", exact: true },
          { label: "Users", href: "/a/data/users", exact: true },
          { label: "Docs", href: "/a/data/docs", exact: true },
          { label: "Projects", href: "/a/data/projects", exact: true },
          { label: "Requests", href: "/a/data/requests", exact: true },
          { label: "Uploads", href: "/a/data/uploads", exact: true },
        ],
      },
      { label: "System", items: [{ label: "Cron health", href: "/a/cron-health", exact: true }] },
      {
        label: "Tools",
        items: [
          { label: "Cache", href: "/a/tools/cache", exact: true },
          { label: "Billing", href: "/a/tools/billing", exact: true },
        ],
      },
    ],
    [],
  );
/**
   * Return whether active.
   */


  function isActive(item: NavItem) {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  return (
    <aside className="lnkdrp-sidebar relative z-50 h-screen w-[280px] shrink-0 overflow-hidden border-r border-[color-mix(in_srgb,var(--border)_35%,transparent)] bg-[var(--sidebar-bg)]">
      <div className="flex h-full flex-col">
        <div className="px-4 pb-5 pt-5">
          <div className="flex min-w-0 min-h-[34px] items-center gap-2">
            <Link href="/" className="inline-flex shrink-0 items-center gap-2" aria-label="Home">
              <Image src={logoSrc} alt="LinkDrop" width={28} height={28} className="block" />
            </Link>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              aria-label="Back to app"
              title="Back to app"
            >
              <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back to app</span>
              <span className="sm:hidden">Back</span>
            </Link>
          </div>
        </div>

        <nav className="mt-1 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
          <div className="grid gap-4">
            {sections.map((section) => (
              <section key={section.label}>
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  {section.label}
                </div>
                {section.items.length ? (
                  <ul className="mt-1 space-y-1">
                    {section.items.map((item) => {
                      const active = isActive(item);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            className={[
                              "block rounded-lg py-1.5 pl-5 pr-2 text-left text-[13px] font-medium transition-colors",
                              active
                                ? "bg-[var(--sidebar-hover)] text-[var(--fg)]"
                                : "text-[var(--muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]",
                            ].join(" ")}
                          >
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>
        </nav>

        <div className="border-t border-[var(--border)] px-3 py-2">
          <AccountMenu />
        </div>
      </div>
    </aside>
  );
}


