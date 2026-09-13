"use client";

import { useState } from "react";

import type { AgentStatus } from "@/lib/client/useAgentStatus";
import { ASK_YOUR_AGENT, KEY_PLACEHOLDER, whoamiCurl } from "@/lib/mcp/clientSetups";
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

  const result = (() => {
    if (!checked) return null;
    if (loading) return "Checking…";
    if (!status) return "Could not load the status. Try again in a moment.";
    if (status.connected) {
      const bits = ["Connected", status.lastUsedClient, formatRelative(status.lastUsedAt)].filter(Boolean);
      return bits.join(" · ");
    }
    return "No agent has connected yet. Run the command above, then check again.";
  })();

  return (
    <div className="grid gap-4">
      <div>
        <p className="mb-2 text-[13px] text-[var(--muted)]">Run this in a terminal. It works today, before the MCP server ships.</p>
        <CodeBlock lines={whoamiCurl(key)} label="Copy verification command" />
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
