/**
 * AgentHintNotice — the quiet inline note on a form an agent could fill instead, modelled on
 * `PlanLimitNotice` (same `role="status"` panel, same `compact` and dismiss affordances).
 *
 * Copy comes from the shared `AGENT_HINT_COPY` registry, so a form can only show a hint for a job
 * the MCP server actually does. Two rules keep it from becoming noise:
 *
 * - It never appears once an agent has connected to the workspace (`useAgentStatus`): that person
 *   has already been told, by doing it.
 * - Dismissing it is permanent, per key, in `localStorage`. Storage can throw in a private window,
 *   so every access is wrapped; the worst case is a note that comes back.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";

import AgentMark from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { AGENT_HINT_COPY, type AgentHintKey } from "@/lib/client/agentHintCopy";
import { useAgentStatus } from "@/lib/client/useAgentStatus";

/** The marks shown beside the title, in the order the Connect page lists them. */
const HINT_MARKS = ["claude-code", "cursor", "codex", "gemini-cli"] as const;

const STORAGE_PREFIX = "lnkdrp:agent-hint-dismissed:";

/** True once this key has been dismissed on this browser. Never throws. */
function readDismissed(key: AgentHintKey): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
}

/** Remember the dismissal. Never throws; a blocked store just means the note returns. */
function writeDismissed(key: AgentHintKey): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, "1");
  } catch {
    // Private window or blocked site data: nothing to do.
  }
}

type Props = {
  /** Which form this is. Only keys in `AGENT_HINT_COPY` have a tool behind them. */
  hintKey: AgentHintKey;
  /** Tighter spacing for modals and narrow side panels. */
  compact?: boolean;
  className?: string;
};

/**
 * Inline note naming the MCP tool that does this form's job, with a link to `/connect`.
 */
export default function AgentHintNotice({ hintKey, compact = true, className }: Props) {
  const copy = AGENT_HINT_COPY[hintKey];
  const { status, loading } = useAgentStatus();
  // `localStorage` exists only in the browser, so the first render has to match the server's:
  // nothing. `checked` flips after mount, once the stored dismissal has been read.
  const [dismissed, setDismissed] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed(hintKey));
    setChecked(true);
  }, [hintKey]);

  if (!checked || dismissed) return null;
  // Someone who has connected an agent already knows. While the status is still loading, stay
  // quiet rather than show a note that disappears a moment later.
  if (loading || status?.connected) return null;

  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--panel-2)]",
        compact ? "px-3 py-2" : "px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-[var(--muted-2)]" aria-hidden="true">
              {HINT_MARKS.map((client) => (
                <AgentMark key={client} client={client} className="h-3 w-3" />
              ))}
            </span>
            <span className={cn("font-semibold text-[var(--fg)]", compact ? "text-[12px]" : "text-[13px]")}>
              {copy.title}
            </span>
          </div>
          <div className={cn("mt-0.5 text-[var(--muted-2)]", compact ? "text-[11px] leading-4" : "text-[12px] leading-5")}>
            {copy.line}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {copy.tools.map((tool) => (
              <code
                key={tool}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]"
              >
                {tool}
              </code>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          onClick={() => {
            setDismissed(true);
            writeDismissed(hintKey);
          }}
          aria-label="Dismiss"
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "mt-2" : "mt-3")}>
        <Link
          href="/connect"
          className={cn(
            compact ? "rounded-lg px-2 py-1 text-[11px] font-semibold" : "rounded-lg px-3 py-1.5 text-[12px] font-semibold",
            "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
          )}
        >
          Connect an agent
        </Link>
      </div>
    </div>
  );
}
