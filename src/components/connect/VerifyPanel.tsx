"use client";

import { useEffect, useState } from "react";

import type { AgentStatus } from "@/lib/client/useAgentStatus";
import { ASK_YOUR_AGENT, KEY_PLACEHOLDER, SITE_ORIGIN, whoamiCurl } from "@/lib/mcp/clientSetups";
import CodeBlock from "./CodeBlock";
import { formatRelative } from "./format";

/**
 * The verification step: a curl against `/api/agent/whoami` (works today), the prompt to give an
 * agent instead, and a "Check status" button that refetches the workspace agent status and reports
 * the result inline.
 */
export default function VerifyPanel({
  plaintextKey,
  status,
  loading,
  onCheck,
}: {
  plaintextKey: string | null;
  status: AgentStatus | null;
  loading: boolean;
  /** Invalidates the shared status cache and refetches; the result arrives through `status`. */
  onCheck: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const key = plaintextKey ?? KEY_PLACEHOLDER;
  // The command targets the server this page is running on: a key minted on a dev server is only
  // known there. Read after mount so server and client render the same first frame.
  const [origin, setOrigin] = useState(SITE_ORIGIN);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) setOrigin(window.location.origin);
  }, []);
  const isLocal = origin !== SITE_ORIGIN;

  const result = (() => {
    if (!checked) return null;
    if (loading) return "Checking…";
    if (!status) return "Could not load the status. Try again in a moment.";
    if (status.connected) {
      const bits = ["Connected", status.lastUsedClient, formatRelative(status.lastUsedAt)].filter(Boolean);
      return bits.join(" · ");
    }
    if (status.verified && status.lastVerified) {
      return `Key verified with ${status.lastVerified.client} ${formatRelative(status.lastVerified.at)}. No agent client has connected yet; that happens on its first tool call once your client is set up.`;
    }
    return "No agent has connected yet. Run the command above, then check again.";
  })();

  return (
    <div className="grid gap-4">
      <div>
        <p className="mb-2 text-[13px] text-[var(--muted)]">Run this in a terminal. It works today, before the MCP server ships.</p>
        <CodeBlock lines={whoamiCurl(key, origin)} label="Copy verification command" />
        {isLocal ? (
          <p className="mt-2 text-[12px] leading-5 text-[var(--muted-2)]">
            You are on <code className="font-mono">{origin}</code>, so the command targets this server. Keys created here do not work on {SITE_ORIGIN.replace(/^https?:\/\//, "")}.
          </p>
        ) : null}
      </div>
      <p className="text-[13px] leading-5 text-[var(--muted)]">
        Or ask your agent: <span className="text-[var(--fg)]">“{ASK_YOUR_AGENT}”</span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setChecked(true);
            onCheck();
          }}
          disabled={checked && loading}
          className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
        >
          {checked && loading ? "Checking…" : "Check status"}
        </button>
        {result ? (
          <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-[13px] text-[var(--muted)]">
            {checked && !loading && status ? (
              <span
                aria-hidden="true"
                className={["h-1.5 w-1.5 rounded-full", status.connected ? "bg-emerald-500" : "bg-[var(--muted-2)]"].join(" ")}
              />
            ) : null}
            <span className={status?.connected && !loading ? "text-[var(--fg)]" : undefined}>{result}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
