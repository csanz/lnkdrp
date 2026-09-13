/**
 * Public overview at `/mcp`: what connecting an agent to lnkdrp looks like, one card per supported
 * MCP client linking to its guide, the tool catalog, and the sign-in link to create a key.
 * Driven by `src/lib/mcp/clientSetups.ts`.
 */
import type { Metadata } from "next";
import Link from "next/link";

import ToolCatalogTable from "@/components/connect/ToolCatalogTable";
import { CLIENT_SETUPS, GUIDES_LAST_UPDATED, MCP_URL } from "@/lib/mcp/clientSetups";
import PublicGuideShell from "@/components/connect/PublicGuideShell";

export const metadata: Metadata = {
  title: "Connect your AI agent to lnkdrp",
  description:
    "Set up lnkdrp as an MCP server in Claude Code, Cursor, Codex, Gemini CLI, Cowork, Grok or any MCP client. Your agent creates share links and reads who opened them.",
  alternates: { canonical: "/mcp" },
};

/** Render the public MCP overview. */
export default function McpOverviewPage() {
  return (
    <PublicGuideShell>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">MCP</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">Connect your AI agent to lnkdrp</h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
        lnkdrp is an MCP server at <code className="font-mono text-[0.92em] text-white/80">{MCP_URL}</code>. Add it to your client
        with a key from your workspace and your agent creates share links, sets passwords and reads the numbers. The server ships
        with launch; keys and the verification endpoint work today.
      </p>

      <h2 className="mt-12 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Pick your client</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {CLIENT_SETUPS.map((c) => (
          <li key={c.slug}>
            <Link
              href={`/mcp/${c.slug}`}
              className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none"
            >
              <span className="text-[15px] font-semibold text-white">{c.label}</span>
              <span className="mt-1.5 text-[13px] leading-5 text-white/55">{c.blurb}</span>
              <span className="mt-4 text-[12px] font-medium text-white/60 group-hover:text-white">How to connect →</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">What your agent can do</h2>
        <span className="text-[11px] font-medium tracking-wide text-white/35">Ships with launch</span>
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <ToolCatalogTable />
      </div>

      <div className="mt-12 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-7">
        <h2 className="font-serif text-2xl tracking-tight text-white">Ready to connect?</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-white/60">
          Keys are created in your workspace and shown once. One key per agent or machine, up to ten per workspace.
        </p>
        <Link
          href="/connect"
          className="mt-5 inline-flex h-10 items-center justify-center rounded-xl bg-white px-5 text-[14px] font-semibold text-black transition-colors hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none"
        >
          Sign in to create a key
        </Link>
      </div>

      <p className="mt-10 text-[12px] text-white/35">Last updated: {GUIDES_LAST_UPDATED}</p>
    </PublicGuideShell>
  );
}
