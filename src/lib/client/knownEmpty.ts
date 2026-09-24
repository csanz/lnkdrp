"use client";

/**
 * What the app already knows a workspace has none of, before a page asks.
 *
 * A new workspace opened every list to a blank frame, then a skeleton, then "No documents yet":
 * a request to confirm what the sidebar snapshot (documents, projects, request inboxes, with
 * totals) and the plan snapshot (usage counts) already said. Both are in memory the moment the
 * shell has rendered, so a page can paint its empty state on the first frame and let the
 * request confirm it.
 *
 * `true` means known empty. `false` means known non-empty. `null` means not known yet, and a
 * page must then wait as it always did. Nothing here is ever the authority: when the page's
 * own payload lands it wins, so the worst case of a stale snapshot is an empty state that fills
 * in, which reads as fast, rather than a list that vanishes.
 */
import { useEffect, useState } from "react";

import { peekPlan, PLAN_CHANGED_EVENT } from "@/lib/client/usePlan";
import { ACTIVE_ORG_CHANGED_EVENT, SIDEBAR_CACHE_UPDATED_EVENT, getSidebarCacheSnapshot } from "@/lib/sidebarCache";

export type KnownEmpty = {
  docs: boolean | null;
  projects: boolean | null;
  requests: boolean | null;
  /** From the sidebar snapshot's `activity.any`; `null` on a snapshot written before it existed. */
  activity: boolean | null;
};

/** Synchronous read; safe on the server (answers all-unknown). */
export function peekKnownEmpty(): KnownEmpty {
  if (typeof window === "undefined") return { docs: null, projects: null, requests: null, activity: null };
  const snap = getSidebarCacheSnapshot();
  const plan = peekPlan();
  const fromTotal = (total: number | undefined): boolean | null => (typeof total === "number" ? total === 0 : null);
  const docs = fromTotal(snap?.docs?.total) ?? (plan ? plan.usage.documents === 0 : null);
  const projects = fromTotal(snap?.projects?.total) ?? (plan ? plan.usage.projects === 0 : null);
  const requests = fromTotal(snap?.requests?.total);
  const activity = typeof snap?.activity?.any === "boolean" ? !snap.activity.any : null;
  return { docs, projects, requests, activity };
}

/** Subscribe to the same answer; re-reads when the sidebar snapshot or the plan changes. */
export function useKnownEmpty(): KnownEmpty {
  const [state, setState] = useState<KnownEmpty>(() => peekKnownEmpty());
  useEffect(() => {
    const sync = () => setState(peekKnownEmpty());
    sync();
    window.addEventListener(SIDEBAR_CACHE_UPDATED_EVENT, sync);
    window.addEventListener(PLAN_CHANGED_EVENT, sync);
    window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(SIDEBAR_CACHE_UPDATED_EVENT, sync);
      window.removeEventListener(PLAN_CHANGED_EVENT, sync);
      window.removeEventListener(ACTIVE_ORG_CHANGED_EVENT, sync);
    };
  }, []);
  return state;
}
