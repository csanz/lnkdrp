"use client";

/**
 * Client UI for `/connect`.
 *
 * Top to bottom: header with the live agent status, the three-step rail, the keys panel (create
 * reveals the plaintext once), client tabs rendered with that key, the verify block, the tool
 * catalog and troubleshooting. Status comes from the shared `useAgentStatus()` cache, which the
 * sidebar also reads, so creating or revoking a key updates both.
 */

import { useCallback, useState } from "react";
import { CpuChipIcon } from "@heroicons/react/24/outline";

import { refreshAgentStatus, useAgentStatus, type AgentKeyRow } from "@/lib/client/useAgentStatus";
import ClientTabs from "@/components/connect/ClientTabs";
import KeysPanel from "@/components/connect/KeysPanel";
import Panel from "@/components/connect/Panel";
import StatusPill from "@/components/connect/StatusPill";
import StepsRail from "@/components/connect/StepsRail";
import ToolCatalogTable from "@/components/connect/ToolCatalogTable";
import Troubleshooting from "@/components/connect/Troubleshooting";
import VerifyPanel from "@/components/connect/VerifyPanel";

/** Render the Connect page UI. */
export default function ConnectPageClient() {
  const { status, loading, refresh } = useAgentStatus();
  // The plaintext of the key created on this visit, kept only in memory so the commands can use it.
  const [created, setCreated] = useState<{ plaintext: string; key: AgentKeyRow } | null>(null);

  const activeKeys = status ? status.keys.filter((k) => !k.revoked).length : 0;
  const connected = Boolean(status?.connected);
  const currentStep: 1 | 2 | 3 = connected ? 3 : activeKeys > 0 ? 2 : 1;

  const onCreated = useCallback((plaintext: string, key: AgentKeyRow) => setCreated({ plaintext, key }), []);
  const onRevoked = useCallback((id: string) => {
    setCreated((prev) => (prev && prev.key.id === id ? null : prev));
  }, []);
  const check = useCallback(() => {
    // Drop the shared cache (sidebar refetches too), then refetch here with a visible loading state.
    refreshAgentStatus();
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <CpuChipIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
            <h1 className="text-sm font-semibold text-[var(--fg)]">Connect your agent</h1>
          </div>
          <StatusPill status={status} loading={loading} />
        </div>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--muted-2)]">
          Create links and read the numbers from Claude Code, Cursor, Codex, or any MCP client. One key per agent or machine.
        </p>
        <div className="mt-4">
          <StepsRail current={currentStep} done={connected} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)] px-6 py-6" aria-busy={loading && !status}>
        {/* Left-aligned under the header like the other app pages, growing with the viewport. On wide
            screens the reference material (tool catalog, troubleshooting) moves into a side column so
            the page uses the width instead of leaving a narrow strip in the middle. */}
        <div className="grid w-full max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] xl:items-start">
          <div className="grid min-w-0 gap-6">
            <KeysPanel status={status} loading={loading} onCreated={onCreated} onRevoked={onRevoked} />

            <Panel id="client" step={2} title="Add lnkdrp to your client" caption="Pick your client">
              <ClientTabs plaintextKey={created?.plaintext ?? null} />
            </Panel>

            <Panel id="verify" step={3} title="Verify" caption="Works today">
              <VerifyPanel plaintextKey={created?.plaintext ?? null} status={status} loading={loading} onCheck={check} />
            </Panel>
          </div>

          <aside className="grid min-w-0 gap-6 xl:sticky xl:top-0">
            <Panel id="tools" title="What your agent can do" caption="Ships with launch">
              {/* Table below xl (full width), stacked rows in the xl side column. */}
              <div className="xl:hidden">
                <ToolCatalogTable />
              </div>
              <div className="hidden xl:block">
                <ToolCatalogTable layout="stack" />
              </div>
            </Panel>

            <Panel id="troubleshooting" title="Troubleshooting">
              <Troubleshooting />
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}
