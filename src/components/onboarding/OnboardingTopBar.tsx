"use client";

/**
 * The bar across the top of a setup flow: the mark, who you are signed in as, and a way out.
 *
 * The mark used to sit inside the content column, directly above the step counter, where it read
 * as the first line of the content rather than as branding. That was the smaller problem.
 *
 * The real one was that a setup flow had **no way out**. `/welcome` stands in front of the app and
 * offers Continue and Skip, both of which go *forward*. Someone who signed in with the wrong
 * Google account — an easy mistake when you have a personal one and a work one — had no visible
 * sign-out, at the moment they are least invested in the product. "Logged in as …" is here so the
 * mistake is visible, and `Log out` is here so it is fixable.
 *
 * Deliberately no "Get help": there is no support inbox behind it yet, and a dead help link on the
 * first screen is worse than none.
 *
 * `progress` draws the line under the bar, full width of the viewport rather than of the column,
 * which is what makes it read as progress through the page instead of a rule inside a box.
 */
import Image from "next/image";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export default function OnboardingTopBar({
  email,
  progress,
}: {
  /** Shown as "Logged in as …". Omitted when we do not know it. */
  email?: string;
  /** 0–1. Omit for a flow with no steps. */
  progress?: number;
}) {
  // `resolvedTheme` is undefined until the client has mounted; picking the black mark until then
  // keeps the server and first client render agreeing, so React does not warn about a mismatch.
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const pct = typeof progress === "number" ? Math.max(0, Math.min(1, progress)) * 100 : null;

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Image
          src={mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3"}
          alt="LinkDrop"
          width={24}
          height={24}
          priority
        />
        <div className="flex items-center gap-4 text-[13px]">
          {email ? (
            <span className="hidden text-[var(--muted)] sm:inline">
              Logged in as <span className="text-[var(--fg)]">{email}</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void signOut({ callbackUrl: "/login" })}
            className="text-[var(--muted)] underline-offset-4 transition-colors hover:text-[var(--fg)] hover:underline"
          >
            Log out
          </button>
        </div>
      </div>

      {/* Sits on the border itself, so the bar keeps its height whether or not there is progress. */}
      {pct === null ? null : (
        <div className="relative h-px">
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500 transition-[width] duration-300 dark:bg-emerald-400"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </header>
  );
}
