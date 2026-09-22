"use client";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import Link from "next/link";

/**
 * Client UI for `/connect`.
 *
 * Top to bottom: header with the live agent status, the three-step rail, the keys panel (create
 * reveals the plaintext once), client tabs rendered with that key, the verify block, the tool
 * catalog and troubleshooting. Status comes from the shared `useAgentStatus()` cache, which the
 * sidebar also reads, so creating or revoking a key updates both.
 */

import { useCallback, useMemo, useState } from "react";
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
import { formatRelative } from "@/components/connect/format";
import { useOrgsSnapshot } from "@/lib/orgs/useOrgsSnapshot";

/** Render the Connect page UI. */
export default function ConnectPageClient() {
  // 4s while on this page: a first tool call or the verify curl shows up without a click.
  const { status, loading, refresh } = useAgentStatus({ pollMs: 4_000 });
  // The plaintext of the key created on this visit, kept only in memory so the commands can use it.
  const [created, setCreated] = useState<{ plaintext: string; key: AgentKeyRow } | null>(null);
  // A saved key pasted back through "Use in commands" (memory only; the server never sees it).
  const [pasted, setPasted] = useState<string | null>(null);
  const plaintextKey = created?.plaintext ?? pasted;
  // Keys and the connection name belong to the active workspace.
  const { stableOrgs, activeOrgId } = useOrgsSnapshot();
  const workspace = useMemo(() => {
    const row = stableOrgs.find((o) => o.id === activeOrgId);
    return row ? { name: row.name, isPersonal: row.type === "personal" } : null;
  }, [stableOrgs, activeOrgId]);

  const activeKeys = status ? status.keys.filter((k) => !k.revoked).length : 0;
  const connected = Boolean(status?.connected);
  // A verified key (curl) completes step 3 as well: the key works; the agent's own first call
  // upgrades the pill from "Key verified" to "Connected".
  const verified = Boolean(status?.verified);
  const currentStep: 1 | 2 | 3 = connected || verified ? 3 : activeKeys > 0 ? 2 : 1;

  const onCreated = useCallback((plaintext: string, key: AgentKeyRow) => setCreated({ plaintext, key }), []);
  const onUse = useCallback((plaintext: string) => {
    setCreated(null);
    setPasted(plaintext);
  }, []);
  const onRevoked = useCallback((id: string) => {
    setCreated((prev) => (prev && prev.key.id === id ? null : prev));
    // The revoked row's prefix is unknown here; the status refetch re-derives "in use" per row, and
    // a revoked key in the commands is harmless (it fails with 401, which the guides explain).
  }, []);
  const check = useCallback(() => {
    // Drop the shared cache (sidebar refetches too), then refetch here with a visible loading state.
    refreshAgentStatus();
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={CpuChipIcon}
        title="Agents"
        description="Create links and read the numbers from Claude Code, Cursor, Codex, or any MCP client. One key per agent or machine."
        actions={<StatusPill status={status} loading={loading} href={connected || verified ? "/activity?who=agents" : undefined} />}
      >
        <StepsRail current={currentStep} done={connected || verified} />
      </AppPageHeader>

      <div className={`min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={loading && !status}>
        {/* Left-aligned under the header like the other app pages, growing with the viewport. On wide
            screens the reference material (tool catalog, troubleshooting) moves into a side column so
            the page uses the width instead of leaving a narrow strip in the middle. */}
        {connected && status ? (
          <div className="mb-6 flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3 text-[13px] text-[var(--fg)]">
              <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--chart-views)]" />
              <span className="min-w-0">
                <span className="font-semibold">
                  {status.connectedCount} {status.connectedCount === 1 ? "agent" : "agents"} connected
                </span>
                <span className="text-[var(--muted)]">
                  {" "}· {status.clients.map((c) => c.client).join(", ")}
                  {status.lastUsedAt ? ` · last activity ${formatRelative(status.lastUsedAt).toLowerCase()}` : ""}
                </span>
              </span>
            </div>
            <Link href="/activity?who=agents" className="shrink-0 text-[13px] font-semibold text-[var(--fg)] underline-offset-4 hover:underline">
              See what they did →
            </Link>
          </div>
        ) : null}
        <div className="grid w-full grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] xl:items-start">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
            <KeysPanel status={status} loading={loading} plaintextKey={plaintextKey} onCreated={onCreated} onUse={onUse} onRevoked={onRevoked} />

            <Panel id="client" step={2} title="Add lnkdrp to your client" caption="Pick your client">
              <ClientTabs plaintextKey={plaintextKey} workspace={workspace} />
            </Panel>

            <Panel id="verify" step={3} title="Verify" caption="Works today">
              <VerifyPanel plaintextKey={plaintextKey} status={status} loading={loading} onCheck={check} />
            </Panel>
          </div>

          <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:sticky xl:top-0">
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
