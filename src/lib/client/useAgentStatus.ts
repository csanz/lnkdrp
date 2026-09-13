"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ACTIVE_ORG_CHANGED_EVENT } from "@/lib/sidebarCache";

/**
 * Client view of `GET /api/agent/status`: whether any AI agent has authenticated to the active
 * workspace with an API key, when, and from which client. Shared and memoised for 60s across the
 * sidebar and the Connect page; call `refreshAgentStatus()` after creating or revoking a key, and
 * it is dropped on a soft workspace switch so one workspace never shows another's agent status.
 */
export type AgentKeyRow = {
  id: string;
  name: string;
  /** Display prefix, e.g. `lnk_ab12cd34…` — never the full key. */
  prefix: string;
  scopes: Array<"read" | "write">;
  createdAt: string;
  lastUsedAt: string | null;
  /** Client label derived from `x-lnkdrp-agent` / User-Agent on last use, e.g. "Claude Code". */
  lastUsedClient: string | null;
  revoked: boolean;
};

export type AgentStatus = {
  /** True once any active (not revoked) key for this workspace has been used at least once. */
  connected: boolean;
  lastUsedAt: string | null;
  lastUsedClient: string | null;
  activeKeys: number;
  keys: AgentKeyRow[];
  /** Whether the current member may create/revoke keys (owner or admin). */
  canManage: boolean;
};

const TTL_MS = 60_000;
export const AGENT_STATUS_CHANGED_EVENT = "lnkdrp:agent-status-changed";

let cache: { at: number; data: AgentStatus } | null = null;
let inflight: Promise<AgentStatus | null> | null = null;

async function load(force = false): Promise<AgentStatus | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchWithTempUser("/api/agent/status", { cache: "no-store" });
      if (!res.ok) return cache?.data ?? null;
      const data = (await res.json()) as AgentStatus;
      if (!data || typeof data.connected !== "boolean") return cache?.data ?? null;
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

/** Synchronous read of the cached status (no fetch); `null` when nothing has loaded yet. */
export function peekAgentStatus(): AgentStatus | null {
  return cache?.data ?? null;
}

/** Invalidate the shared cache and tell every mounted `useAgentStatus` to refetch. */
export function refreshAgentStatus(): void {
  cache = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AGENT_STATUS_CHANGED_EVENT));
}

if (typeof window !== "undefined") {
  window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, () => refreshAgentStatus());
}

/** Subscribe to the workspace agent status. `status` is null until the first response arrives. */
export function useAgentStatus(): { status: AgentStatus | null; loading: boolean; refresh: () => void } {
  const [status, setStatus] = useState<AgentStatus | null>(() => cache?.data ?? null);
  const [loading, setLoading] = useState(!cache);

  const refresh = useCallback(() => {
    setLoading(true);
    void load(true).then((d) => {
      setStatus(d);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((d) => {
      if (cancelled) return;
      setStatus(d);
      setLoading(false);
    });
    const onChange = () => {
      void load(true).then((d) => {
        if (!cancelled) setStatus(d);
      });
    };
    window.addEventListener(AGENT_STATUS_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_STATUS_CHANGED_EVENT, onChange);
    };
  }, []);

  return { status, loading, refresh };
}
