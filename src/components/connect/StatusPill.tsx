"use client";

import type { AgentStatus } from "@/lib/client/useAgentStatus";
import { formatRelative } from "./format";

/**
 * "Connected · Claude Code · 3 min ago" with a green dot, or "No agent has connected yet" with a
 * muted dot. Renders a quiet skeleton while the status has not loaded.
 */
export default function StatusPill({ status, loading }: { status: AgentStatus | null; loading: boolean }) {
  if (!status && loading) {
    return (
      <span aria-hidden="true" className="inline-flex h-7 w-40 rounded-full border border-[var(--border)] bg-[var(--panel-2)] motion-safe:animate-pulse" />
    );
  }
  const connected = Boolean(status?.connected);
  const parts = connected
    ? ["Connected", status?.lastUsedClient ?? null, formatRelative(status?.lastUsedAt) || null].filter(Boolean)
    : ["No agent has connected yet"];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1 text-[12px] font-medium text-[var(--muted)]"
    >
      <span
        aria-hidden="true"
        className={["h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-[var(--muted-2)]"].join(" ")}
      />
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true" className="text-[var(--muted-2)]">·</span> : null}
          <span className={i === 0 && connected ? "text-[var(--fg)]" : undefined}>{p}</span>
        </span>
      ))}
    </span>
  );
}
