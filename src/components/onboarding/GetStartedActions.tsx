"use client";

/**
 * The two ways to put something in an empty workspace, offered wherever the emptiness shows.
 *
 * Every list in the app opens the same way for a new account: Activity says "No activity yet",
 * Search says "No documents yet", the metrics page has nothing to chart. Each was accurate and
 * each was a dead end — the page states a fact and leaves the person to work out that the fix is
 * on a different screen.
 *
 * Both actions are named for the outcome rather than the mechanism, and the second one is the
 * product's actual pitch: an agent can do this for you. That is the reason someone chose this over
 * emailing an attachment, and an empty workspace is the one moment they are certain to read it.
 *
 * Renders nothing once the workspace has a document, so it never nags an established user whose
 * list is empty for some ordinary reason — a filter, a quiet week. `plan` is null until it loads,
 * and `=== 0` rather than `!` keeps it from flashing in before we know.
 */
import Link from "next/link";

import { usePlan } from "@/lib/client/usePlan";

export default function GetStartedActions({ className }: { className?: string }) {
  const { plan } = usePlan();
  if (plan?.usage.documents !== 0) return null;

  return (
    <div className={className ?? "mt-5 flex flex-wrap items-center justify-center gap-2.5"}>
      <Link
        href="/upload"
        className="inline-flex items-center rounded-lg bg-[var(--fg)] px-3.5 py-2 text-[13px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85"
      >
        Upload your first document
      </Link>
      <Link
        href="/connect"
        className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3.5 py-2 text-[13px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
      >
        Or connect an agent to do it for you
      </Link>
    </div>
  );
}
