"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  CLIENT_SETUPS,
  DEFAULT_SERVER_NAME,
  KEY_PLACEHOLDER,
  MCP_URL,
  SITE_ORIGIN,
  mcpServerName,
  mcpUrlForOrigin,
  type ClientKey,
} from "@/lib/mcp/clientSetups";
import CodeBlock from "./CodeBlock";

/**
 * Full-width version of the homepage client tabs: one tab per MCP client, the compact install
 * snippet rendered with the freshly created key when there is one (else the placeholder), a short
 * per-client note, and a link to the public guide. The tab row wraps on narrow screens.
 *
 * The connection is named after the active workspace (`lnkdrp-personal`, `lnkdrp-<name>`). Every command used to say `lnkdrp`, so adding a second workspace's key replaced or
 * collided with the first connection.
 */
export default function ClientTabs({
  plaintextKey,
  workspace,
  client,
  onClientChange,
  mode,
}: {
  plaintextKey: string | null;
  /** The active workspace, or null while it loads (commands then use the default connection name). */
  workspace: { name: string; isPersonal: boolean } | null;
  /** Controlled by the page: the chosen client and the chosen path, which the step rail follows too. */
  client: ClientKey;
  onClientChange: (client: ClientKey) => void;
  mode: "signin" | "key";
}) {
  const active = CLIENT_SETUPS.find((c) => c.key === client) ?? CLIENT_SETUPS[0];
  const key = plaintextKey ?? KEY_PLACEHOLDER;
  const useKey = mode === "key" || !active.signIn;
  // Commands point at the MCP server that matches this page's origin (local default on a dev
  // server, production on the site). Read after mount so the first frame matches the server render.
  const [origin, setOrigin] = useState(SITE_ORIGIN);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) setOrigin(window.location.origin);
  }, []);
  const mcp = mcpUrlForOrigin(origin);
  const isLocal = mcp !== MCP_URL;
  const serverName = mcpServerName(workspace);
  const remove = useKey || !active.signIn ? active.remove(serverName) : active.signIn.remove(serverName);
  const lines = useKey || !active.signIn ? active.lines(key, mcp, serverName) : active.signIn.lines(mcp, serverName);
  const note = useKey || !active.signIn ? active.note : active.signIn.note;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)]" role="tablist" aria-label="MCP client">
        {CLIENT_SETUPS.map((c) => {
          const selected = c.key === client;
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`client-panel-${c.key}`}
              id={`client-tab-${c.key}`}
              onClick={() => onClientChange(c.key)}
              className={[
                "-mb-px border-b-2 pb-2 text-[12px] font-medium tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none",
                selected ? "border-[var(--fg)] text-[var(--fg)]" : "border-transparent text-[var(--muted-2)] hover:text-[var(--fg)]",
              ].join(" ")}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`client-panel-${active.key}`} aria-labelledby={`client-tab-${active.key}`} className="pt-4">
        {workspace ? (
          <p className="mb-3 text-[13px] leading-5 text-[var(--muted)]">
            This connects <span className="font-semibold text-[var(--fg)]">{workspace.name}</span> as{" "}
            <code className="font-mono text-[var(--fg)]">{serverName}</code>. Other workspaces get their own name, such as{" "}
            <code className="font-mono">{DEFAULT_SERVER_NAME}-acme</code>, so they sit next to this one.
            {serverName === DEFAULT_SERVER_NAME ? null : (
              <>
                {" "}
                Already added it as plain <code className="font-mono">{DEFAULT_SERVER_NAME}</code>? That keeps working.
              </>
            )}
          </p>
        ) : null}
        <CodeBlock lines={lines} label={`Copy ${active.label} setup`} />
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 text-[12px] leading-5 text-[var(--muted-2)]">
          <p className="min-w-0 flex-1">{note}</p>
          <Link
            href={`/mcp/${active.slug}`}
            className="shrink-0 font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
          >
            Full guide →
          </Link>
        </div>
        <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
          {useKey
            ? `The MCP server ships with launch. Your key already works against the verification endpoint below.${plaintextKey ? "" : " Commands show a placeholder until you create a key under Keys and agents."}`
            : "The MCP server ships with launch. Signing in works the moment it is up: the client finds lnkdrp's sign-in on its own."}
        </p>
        {/* Rotating a key is the one thing every client makes awkward ("lnkdrp already exists"), so
            this gets a real callout rather than a footnote. Closed by default to keep step 2 short. */}
        <details className="group mt-4 rounded-xl border border-[var(--border)] border-l-4 border-l-[var(--fg)] bg-[var(--panel-2)] px-4 py-3 text-[13px] leading-5 text-[var(--muted)]">
          <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block font-semibold text-[var(--fg)]">{useKey ? `Already added ${serverName}? Changing the key or removing it` : `Disconnecting ${serverName}, or connecting again`}</span>
              <span className="block text-[12px] text-[var(--muted-2)]">{useKey ? `Re-running the add command with a new key fails. Here is the fix for ${active.label}.` : `Revoke here, remove in ${active.label}, add again to sign in afresh.`}</span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-[var(--muted-2)] transition-transform group-open:rotate-90">›</span>
          </summary>
          <p className="mt-3">{remove.body}</p>
          {remove.code ? <CodeBlock lines={remove.code} label={`Copy ${active.label} remove command`} className="mt-3" /> : null}
        </details>
        {isLocal ? (
          <p className="mt-1.5 text-[12px] leading-5 text-[var(--muted-2)]">
            Local dev: commands use <code className="font-mono">{mcp}</code>. Set <code className="font-mono">NEXT_PUBLIC_MCP_URL</code> to point elsewhere; production is <code className="font-mono">{MCP_URL}</code>.
          </p>
        ) : null}
      </div>
    </div>
  );
}
