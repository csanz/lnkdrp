/**
 * SidebarCredits — the workspace's remaining AI credits, shown above the account row in the left
 * sidebar and kept current over the realtime channel.
 *
 * Reads `/api/credits/snapshot?fast=1` once on mount, then again (cache-busted) whenever an
 * activity frame says a processing run finished or a replacement/compare/review ran, since those
 * are the moments credits move. A drop in the number flashes the value briefly so the change is
 * noticed; the value turns amber when the balance is low or spent. The tooltip names the grant
 * (one-time starter credits on Free, this cycle's allowance on Pro). Hidden when the credits UI is
 * switched off or the snapshot cannot be read.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { subscribeRealtime } from "@/lib/client/realtime";
import { FEATURE_CREDITS_ENABLED } from "@/lib/client/planLimit";
import { usePlan } from "@/lib/client/usePlan";
import { cn } from "@/lib/cn";

/** Activity types after which the balance may have changed. */
const CREDIT_EVENT_TYPES = new Set(["doc.processed", "doc.replaced", "review.completed", "history.compared", "plan.upgraded"]);

/** At or below this many remaining credits the value turns amber (same tone as the sidebar meters). */
const LOW_CREDITS_THRESHOLD = 10;

export default function SidebarCredits() {
  const { plan } = usePlan();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [flash, setFlash] = useState(false);
  const prevRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!FEATURE_CREDITS_ENABLED) return;
    let cancelled = false;
    const load = async (bust: boolean) => {
      try {
        const res = await fetch(`/api/credits/snapshot?fast=1${bust ? "&bust=1" : ""}`, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { creditsRemaining?: unknown; blocked?: unknown } | null;
        if (cancelled || !res.ok || !json || typeof json.creditsRemaining !== "number") return;
        const next = json.creditsRemaining;
        if (prevRef.current !== null && next !== prevRef.current) {
          setFlash(true);
          if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
          flashTimerRef.current = window.setTimeout(() => setFlash(false), 2400);
        }
        prevRef.current = next;
        setRemaining(next);
        setBlocked(Boolean(json.blocked));
      } catch {
        // leave whatever we had
      }
    };
    void load(false);
    // Coalesce a burst of frames (a run emits several) into one refetch.
    let timer: number | null = null;
    const unsubscribe = subscribeRealtime("activity", (f) => {
      if (f.type !== "activity" || !CREDIT_EVENT_TYPES.has(f.event.type ?? "")) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void load(true);
      }, 600);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  if (!FEATURE_CREDITS_ENABLED || remaining === null) return null;

  const isFree = plan?.plan === "free";
  const low = blocked || remaining <= LOW_CREDITS_THRESHOLD;
  const title = isFree ? "AI starter credits remaining. Opens usage." : "AI credits remaining this cycle. Opens usage.";

  return (
    <Link
      href="/dashboard?tab=usage"
      className="mb-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-[var(--sidebar-hover)]"
      title={title}
    >
      <span className={cn("font-medium", blocked ? "text-amber-700 dark:text-amber-300" : "text-[var(--muted-2)]")}>
        {blocked ? "Out of AI credits" : "AI credits"}
      </span>
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 font-semibold tabular-nums transition-colors duration-700",
          flash ? "bg-[var(--feed-new-bg)]" : null,
          low ? "text-amber-700 dark:text-amber-300" : "text-[var(--fg)]",
        )}
        aria-live="polite"
      >
        {remaining}
      </span>
    </Link>
  );
}
