"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ACTIVE_ORG_CHANGED_EVENT } from "@/lib/sidebarCache";

/**
 * Client view of `GET /api/plan`: plan, limits, usage and grace for the active workspace.
 * Shared, memoised for 30s across components; call `refreshPlan()` after a mutation that changes
 * usage (share toggled, project created, member joined) so meters update immediately. The cache is
 * also dropped on a soft workspace switch (`ACTIVE_ORG_CHANGED_EVENT`) so a Pro workspace never
 * inherits the previous workspace's Free meters.
 */
export type PlanSnapshot = {
  plan: "free" | "pro";
  orgId: string;
  isPersonalOrg: boolean;
  /** The viewer's role in this workspace, or null when they are not a member. */
  role: "owner" | "admin" | "member" | "viewer" | null;
  /** Editing a link takes `member`; revealing its password takes `admin`. Derived server-side. */
  canManageLinks: boolean;
  canRevealPassword: boolean;
  limits: { plan: "free" | "pro"; documents: number | null; projects: number | null; analyticsDays: number | null; collaborators: number };
  usage: { documents: number; projects: number; members: number };
  grace: { startedAt: string; endsAt: string; blockedAt: string | null } | null;
  /** True while a Free workspace is inside its unblocked launch grace window; `atLimit` is then all false. */
  graceActive: boolean;
  atLimit: { documents: boolean; projects: boolean; collaborators: boolean };
  fraction: { documents: number; projects: number };
  upgradeUrl: string;
};

const TTL_MS = 30_000;
export const PLAN_CHANGED_EVENT = "lnkdrp:plan-changed";

let cache: { at: number; data: PlanSnapshot } | null = null;
let inflight: Promise<PlanSnapshot | null> | null = null;

async function load(force = false): Promise<PlanSnapshot | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchWithTempUser("/api/plan", { cache: "no-store" });
      if (!res.ok) return cache?.data ?? null;
      const data = (await res.json()) as PlanSnapshot;
      if (!data || (data.plan !== "free" && data.plan !== "pro")) return cache?.data ?? null;
      cache = { at: Date.now(), data };
      return data;
    } catch {
      return cache?.data ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Synchronous read of the cached snapshot (no fetch); `null` when nothing has loaded yet. */
export function peekPlan(): PlanSnapshot | null {
  return cache?.data ?? null;
}

/** Invalidate the shared cache and tell every mounted `usePlan` to refetch. */
export function refreshPlan(): void {
  cache = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PLAN_CHANGED_EVENT));
}

// A workspace switch changes every number in the snapshot: drop the cache even when no `usePlan`
// is mounted, so the next mount does not reuse the previous workspace's plan for up to 30s.
if (typeof window !== "undefined") {
  window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, () => refreshPlan());
}

/** Subscribe to the workspace plan snapshot. `plan` is null until the first response arrives. */
export function usePlan(): { plan: PlanSnapshot | null; loading: boolean; refresh: () => void } {
  const [plan, setPlan] = useState<PlanSnapshot | null>(() => cache?.data ?? null);
  const [loading, setLoading] = useState(!cache);

  const refresh = useCallback(() => {
    setLoading(true);
    void load(true).then((d) => {
      setPlan(d);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((d) => {
      if (cancelled) return;
      setPlan(d);
      setLoading(false);
    });
    const onChange = () => {
      void load(true).then((d) => {
        if (!cancelled) setPlan(d);
      });
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(PLAN_CHANGED_EVENT, onChange);
    };
  }, []);

  return { plan, loading, refresh };
}
