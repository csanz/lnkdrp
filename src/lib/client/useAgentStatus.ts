"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ACTIVE_ORG_CHANGED_EVENT } from "@/lib/sidebarCache";
import { REALTIME_STATE_EVENT, realtimeState, subscribeRealtime } from "@/lib/client/realtime";

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
  /** Who created the key; shown in shared workspaces so a team can see whose agents are connected. */
  createdBy: { id: string; name: string | null; email: string | null } | null;
};

/** One connected client (distinct `lastUsedClient` across active, used keys), most recent first. */
export type AgentClient = {
  client: string;
  lastUsedAt: string;
  /** Active keys this client has used. */
  keys: number;
  /** Display names of the members whose keys this client used (shared workspaces). */
  by: string[];
};

export type AgentStatus = {
  /** True once an agent client (not an HTTP tool such as curl) has used an active key. */
  connected: boolean;
  /** True once any active key has been used at all, including by curl from the Verify step. */
  verified: boolean;
  /** Latest tool-style use (curl, wget, HTTPie, plain "API key"): proof the key works, not a connection. */
  lastVerified: { at: string; client: string } | null;
  lastUsedAt: string | null;
  lastUsedClient: string | null;
  activeKeys: number;
  keys: AgentKeyRow[];
  /** Distinct connected clients, most recent first; `connectedCount === clients.length`. */
  clients: AgentClient[];
  connectedCount: number;
  /** Personal workspaces have no teammates, so owner names are omitted in the UI. */
  isPersonalOrg: boolean;
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

/**
 * Subscribe to the workspace agent status. `status` is null until the first response arrives.
 *
 * `pollMs` keeps it live without a click: refetch on that interval while the tab is visible, and
 * whenever the tab becomes visible or the window regains focus. Polling is the interim for a
 * push channel (SSE/WebSocket) that Vercel functions cannot hold; the Node host planned for the
 * worker and MCP server is where that will live.
 */
export function useAgentStatus(opts: { pollMs?: number } = {}): { status: AgentStatus | null; loading: boolean; refresh: () => void } {
  const pollMs = opts.pollMs ?? 0;
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
    // Live-ish: poll while visible, and catch up the moment the tab or window comes back.
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load(true).then((d) => {
        if (!cancelled && d) setStatus(d);
      });
    };
    // With the socket open, polling is only a safety net: stretch the interval to at least 60s.
    let timer: number | null = null;
    const armTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (pollMs <= 0) return;
      const every = realtimeState() === "open" ? Math.max(pollMs, 60_000) : pollMs;
      timer = window.setInterval(tick, every);
    };
    armTimer();
    const onRealtimeState = () => armTimer();
    window.addEventListener(REALTIME_STATE_EVENT, onRealtimeState);
    // Push: any key use / create / revoke in this workspace arrives as an "agent" frame.
    const unsubscribe = subscribeRealtime("agent", () => tick());
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    if (pollMs > 0) {
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", tick);
    }
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_STATUS_CHANGED_EVENT, onChange);
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener(REALTIME_STATE_EVENT, onRealtimeState);
      unsubscribe();
      if (pollMs > 0) {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", tick);
      }
    };
  }, [pollMs]);

  return { status, loading, refresh };
}
