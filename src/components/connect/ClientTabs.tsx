"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CLIENT_SETUPS, KEY_PLACEHOLDER, MCP_URL, SITE_ORIGIN, mcpUrlForOrigin, type ClientKey } from "@/lib/mcp/clientSetups";
import CodeBlock from "./CodeBlock";

/**
 * Full-width version of the homepage client tabs: one tab per MCP client, the compact install
 * snippet rendered with the freshly created key when there is one (else the placeholder), a short
 * per-client note, and a link to the public guide. The tab row wraps on narrow screens.
 */
export default function ClientTabs({ plaintextKey }: { plaintextKey: string | null }) {
  const [client, setClient] = useState<ClientKey>("claude");
  const active = CLIENT_SETUPS.find((c) => c.key === client) ?? CLIENT_SETUPS[0];
  const key = plaintextKey ?? KEY_PLACEHOLDER;
  // Commands point at the MCP server that matches this page's origin (local default on a dev
  // server, production on the site). Read after mount so the first frame matches the server render.
  const [origin, setOrigin] = useState(SITE_ORIGIN);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) setOrigin(window.location.origin);
  }, []);
  const mcp = mcpUrlForOrigin(origin);
  const isLocal = mcp !== MCP_URL;

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
              onClick={() => setClient(c.key)}
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
        <CodeBlock lines={active.lines(key, mcp)} label={`Copy ${active.label} setup`} />
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 text-[12px] leading-5 text-[var(--muted-2)]">
          <p className="min-w-0 flex-1">{active.note}</p>
          <Link
            href={`/mcp/${active.slug}`}
            className="shrink-0 font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
          >
            Full guide →
          </Link>
        </div>
        <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
          The MCP server ships with launch. Your key already works against the verification endpoint below.
          {plaintextKey ? null : " Commands show a placeholder until you create a key."}
        </p>
        <details className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[12px] leading-5 text-[var(--muted)]">
          <summary className="cursor-pointer select-none font-medium text-[var(--fg)]">Change the key or remove lnkdrp</summary>
          <p className="mt-2">{active.remove.body}</p>
          {active.remove.code ? <CodeBlock lines={active.remove.code} label={`Copy ${active.label} remove command`} size="sm" className="mt-2" /> : null}
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
