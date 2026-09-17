"use client";

import Link from "next/link";

import type { AgentStatus } from "@/lib/client/useAgentStatus";
import { formatRelative } from "./format";

/**
 * "Connected · Claude Code · 3 min ago" with a green dot, or "No agent has connected yet" with a
 * muted dot. Renders a quiet skeleton while the status has not loaded.
 */
export default function StatusPill({ status, loading, href }: { status: AgentStatus | null; loading: boolean; /** When set, the pill is a link (e.g. to Activity filtered to agents). */ href?: string }) {
  if (!status && loading) {
    return (
      <span aria-hidden="true" className="inline-flex h-7 w-40 rounded-full border border-[var(--border)] bg-[var(--panel-2)] motion-safe:animate-pulse" />
    );
  }
  const connected = Boolean(status?.connected);
  const clients = status?.clients ?? [];
  // "Claude Code, Cursor" up to two names; "3 clients" past that, so the pill stays one line.
  const who =
    clients.length === 0
      ? (status?.lastUsedClient ?? null)
      : clients.length <= 2
        ? clients.map((c) => c.client).join(", ")
        : `${clients.length} clients`;
  const verified = Boolean(status?.verified);
  const parts = connected
    ? ["Connected", who, formatRelative(status?.lastUsedAt) || null].filter(Boolean)
    : verified
      ? ["Key verified", status?.lastVerified?.client ?? null, "waiting for an agent"].filter(Boolean)
      : ["No agent has connected yet"];
  const pillClass =
    "inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1 text-[12px] font-medium text-[var(--muted)]";
  const body = (
    <>
      <span
        aria-hidden="true"
        className={["h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : verified ? "bg-amber-500" : "bg-[var(--muted-2)]"].join(" ")}
      />
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true" className="text-[var(--muted-2)]">·</span> : null}
          <span className={i === 0 && connected ? "text-[var(--fg)]" : undefined}>{p}</span>
        </span>
      ))}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={`${pillClass} transition-colors hover:border-[var(--fg)]/40 hover:text-[var(--fg)]`} title="See what your agents did">
        {body}
        <span aria-hidden="true" className="text-[var(--muted-2)]">→</span>
      </Link>
    );
  }
  return (
    <span role="status" className={pillClass}>
      {body}
    </span>
  );
}
