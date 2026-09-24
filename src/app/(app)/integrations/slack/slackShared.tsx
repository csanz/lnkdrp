"use client";

/**
 * Shared between the integrations list and the Slack page: the connections hook, the status
 * line the card shows, and the Slack mark.
 */
import { useCallback, useEffect, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { SlackConnectionDto } from "@/lib/slack/connections";

export type SlackState = { enabled: boolean; connections: SlackConnectionDto[] };

export function useSlackConnections(): { data: SlackState | null; error: string | null; loading: boolean; refresh: () => Promise<void>; setData: (next: SlackState) => void } {
  const [data, setData] = useState<SlackState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithTempUser("/api/orgs/active/slack", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as (SlackState & { error?: string }) | null;
      if (!res.ok || !json) throw new Error(json?.error || "Could not load Slack settings.");
      setData({ enabled: Boolean(json.enabled), connections: Array.isArray(json.connections) ? json.connections : [] });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Slack settings.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh, setData };
}

export function slackStatusLine(state: { data: SlackState | null; loading: boolean }): { text: string; tone: "on" | "off" | "warn" } {
  if (state.loading && !state.data) return { text: "…", tone: "off" };
  const d = state.data;
  if (!d || !d.enabled) return { text: "Not available", tone: "off" };
  if (!d.connections.length) return { text: "Not connected", tone: "off" };
  const revoked = d.connections.filter((c) => c.status === "revoked");
  if (revoked.length === d.connections.length) return { text: "Disconnected", tone: "warn" };
  const def = d.connections.find((c) => c.isDefault) ?? d.connections[0];
  const extra = d.connections.length - 1;
  return { text: extra > 0 ? `${def.channelName} +${extra}` : def.channelName, tone: revoked.length ? "warn" : "on" };
}

/** Slack's four-colour mark, inline so it needs no asset and follows nothing but itself. */
export function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#E01E5A" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 0 1-5.04 0v-6.32z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04h6.31z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 0 1 5.04 0v6.31z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 0 1 0 5.04h-6.31z" />
    </svg>
  );
}
