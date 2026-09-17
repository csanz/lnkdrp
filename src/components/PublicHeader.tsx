/**
 * Shared static, transparent header for public (logged-out) pages: `/`, `/about`, `/pricing`, `/tos`, `/privacy`.
 * Legal links (Terms, Privacy) live in `PublicFooter`, not here.
 *
 * Markup and class names intentionally match the logged-out homepage header so the header
 * renders identically everywhere. The only prop, `containerClassName`, lets a page align the
 * header's inner container with its own content column (the homepage uses it; other pages
 * keep the full-bleed default).
 */
"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";
import Spinner from "@/components/ui/Spinner";

// Tighter horizontal padding below `sm` keeps all three links on one row on phones.
const NAV_LINK_CLASS =
  "rounded-xl px-2 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white sm:px-3";

/**
 * "Log In" button that starts Google sign-in (uses signIn, local busy state).
 */
function LoginButton({ enabled }: { enabled: boolean }) {
  const [isSigningIn, setIsSigningIn] = useState(false);
  return (
    <button
      type="button"
      className={`relative ${NAV_LINK_CLASS}`}
      disabled={isSigningIn}
      aria-busy={isSigningIn}
      onClick={() => {
        // Auth disabled (local/dev): keep the button but do nothing, matching prior public pages.
        if (!enabled || isSigningIn) return;
        setIsSigningIn(true);
        void signIn("google", { callbackUrl: "/" });
      }}
    >
      {/* Same as the home and login buttons: the label keeps the width, a spinner overlays it, and
          no provider is named. */}
      <span className={isSigningIn ? "invisible" : ""}>Log In</span>
      {isSigningIn ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="h-4 w-4" label="Signing in" />
        </span>
      ) : null}
    </button>
  );
}

/**
 * Session-aware login control: "Open app" link when authenticated, otherwise the Log In button.
 * Only rendered when auth is enabled (a `SessionProvider` is guaranteed to be mounted then).
 */
function SessionLoginControl() {
  const { status } = useSession();
  if (status === "authenticated") {
    return (
      <Link href="/" className={NAV_LINK_CLASS}>
        Open app
      </Link>
    );
  }
  return <LoginButton enabled />;
}

/**
 * Render the PublicHeader UI (static, transparent, logo left + About/Connect your agent/Pricing/Log In right).
 */
export default function PublicHeader({ containerClassName }: { containerClassName?: string } = {}) {
  const authEnabled = useAuthEnabled();
  return (
    // Same geometry as `BrandHeader` (transparent border included, 46px row) so the logo sits at the
    // exact same spot when someone moves from a marketing page to login or a share link.
    <header className="relative z-20 w-full border-b border-transparent bg-transparent text-white/90">
      <div className={containerClassName ?? "px-4 py-3 sm:px-6"}>
        <div className="flex min-h-[46px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
              <Image src="/icon-white.svg?v=3" alt="LinkDrop" width={26} height={26} priority className="block" />
            </Link>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link href="/about" className={NAV_LINK_CLASS}>
              About
            </Link>
            {/* Says what the page is for rather than naming the protocol; the short form keeps all four
                links on one row on a phone. Same words as the home page's "Connect your agent" section,
                which links to the same guide. */}
            <Link href="/mcp" className={NAV_LINK_CLASS} aria-label="Connect your agent">
              <span className="sm:hidden">Connect</span>
              <span className="hidden sm:inline">Connect your agent</span>
            </Link>
            <Link href="/pricing" className={NAV_LINK_CLASS}>
              Pricing
            </Link>
            {authEnabled ? <SessionLoginControl /> : <LoginButton enabled={false} />}
          </div>
        </div>
      </div>
    </header>
  );
}
