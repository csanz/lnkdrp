"use client";

import Link from "next/link";

import { useAgentStatus } from "@/lib/client/useAgentStatus";
import { TOOL_CATALOG } from "@/lib/mcp/clientSetups";

/**
 * The Overview's card for the product's headline feature: agents driving the workspace over MCP.
 *
 * Two jobs. It shows whether an agent is connected right now — the same status the sidebar reads,
 * so the two never disagree — and it is the dashboard's one route to the full tool reference,
 * which until this card existed was reachable only by guessing that the sidebar's "Agents" entry
 * led somewhere with documentation. The count of tools and of those that ask before acting comes
 * from the catalog itself, so this card cannot go stale when a tool is added.
 */
export default function AgentsCard() {
  const { status } = useAgentStatus({ pollMs: 30_000 });
  const total = TOOL_CATALOG.length;
  const confirming = TOOL_CATALOG.filter((t) => t.confirms).length;
  const connected = Boolean(status?.connected);
  const clients = status?.clients?.map((c) => c.client).filter(Boolean) ?? [];
  const who = clients.length ? clients.join(", ") : status?.lastUsedClient ?? null;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">Agents</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            Let Claude Code, Cursor or any MCP client share, manage and read the analytics of your documents.
          </div>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <span
            aria-hidden="true"
            className={["inline-block h-2 w-2 rounded-full", connected ? "bg-emerald-500" : "bg-[var(--muted-2)]"].join(" ")}
          />
          <span className="text-[var(--muted)]">
            {status === null || status === undefined
              ? "Checking…"
              : connected
                ? `${who ?? "An agent"} connected`
                : who
                  ? `Not connected · last used by ${who}`
                  : "Not connected"}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Tools" value={String(total)} hint="Read and write, over MCP" />
        <Stat label="Ask you first" value={String(confirming)} hint="Deletes and archives confirm before acting" />
        <Stat label="Keys" value={status?.activeKeys != null ? String(status.activeKeys) : "—"} hint="Active API keys on this workspace" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <Link href="/connect#tools" className="font-semibold text-[var(--fg)] underline-offset-4 hover:underline">
          See every tool and what it does
        </Link>
        <Link href="/connect" className="text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline">
          {connected ? "Manage keys" : "Connect an agent"}
        </Link>
        <Link href="/mcp" className="text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline">
          Setup guides
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-[var(--panel-2)] p-4">
      <div className="text-[12px] font-semibold text-[var(--muted-2)]">{label}</div>
      <div className="mt-2 text-[26px] font-semibold tracking-tight text-[var(--fg)] tabular-nums">{value}</div>
      <div className="mt-1 text-[12px] text-[var(--muted-2)]">{hint}</div>
    </div>
  );
}
