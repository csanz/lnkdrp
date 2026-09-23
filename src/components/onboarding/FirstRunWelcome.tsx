"use client";

/**
 * The greeting on an empty workspace: what this thing is, and the two ways to start.
 *
 * Someone who has just finished `/welcome` lands on a page whose largest element is a dashed box
 * saying "Drop a PDF anywhere on this page". That tells them the mechanic and nothing about the
 * point — the point is what happens *after* the drop, which is the only reason to use this instead
 * of emailing an attachment. This says that once, and then gets out of the way.
 *
 * **It disappears on its own.** Visibility is "the workspace has no documents", not a flag, so the
 * first upload removes it without anything being written or remembered. The dismiss button is for
 * the person who has read it and is not ready to upload yet; that one preference is per-browser in
 * `localStorage`, which is the right weight for "I have read the greeting" — losing it on another
 * device costs one more glance at a card they have already read.
 *
 * `localStorage` is wrapped because it throws outright in a private window with site data blocked,
 * and a greeting is never worth a blank page.
 */
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { XMarkIcon } from "@heroicons/react/24/outline";

const DISMISS_KEY = "lnkdrp:first-run-welcome-dismissed";

/** Has this browser already dismissed the greeting? Never throws. */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export default function FirstRunWelcome({
  show,
  actions,
}: {
  /** The caller's rule for whether this workspace is still empty. */
  show: boolean;
  /** The buttons. Real ones only — a greeting that offers a dead link is worse than no greeting. */
  actions: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  // Both start false so the server and the first client render agree; the effect settles them.
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDismissed(readDismissed());
  }, []);

  if (!show || !mounted || dismissed) return null;

  return (
    <section
      className="relative mb-6 overflow-hidden rounded-2xl border border-emerald-600/25 bg-emerald-500/[0.04] px-6 py-6 dark:border-emerald-300/20"
      aria-labelledby="first-run-welcome-title"
    >
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // A greeting that cannot remember being dismissed is still dismissed for this view.
          }
        }}
        aria-label="Dismiss"
        className="absolute right-3 top-3 rounded-md p-1.5 text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden="true" />
      </button>

      <Image
        src={resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3"}
        alt=""
        width={22}
        height={22}
        aria-hidden="true"
      />

      <h2 id="first-run-welcome-title" className="mt-4 text-[17px] font-semibold tracking-tight text-[var(--fg)]">
        Welcome to LinkDrop
      </h2>
      <p className="mt-2 max-w-[62ch] text-[14px] leading-6 text-[var(--muted)]">
        Drop a PDF and you get a link to send. From the first time someone opens it you can see who
        they were, how far they read, and which pages they skipped — and when you replace the file,
        the link stays the same and everyone gets the new version.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">{actions}</div>
    </section>
  );
}
