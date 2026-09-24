/**
 * Public overview at `/mcp`: what connecting an agent to lnkdrp looks like, one card per supported
 * MCP client linking to its guide, the tool catalog, and the sign-in link to create a key.
 * Driven by `src/lib/mcp/clientSetups.ts`.
 */
import type { Metadata } from "next";
import Link from "next/link";

import ToolCatalogTable from "@/components/connect/ToolCatalogTable";
import { CLIENT_SETUPS, GUIDES_LAST_UPDATED, MCP_URL, MULTIPLE_WORKSPACES } from "@/lib/mcp/clientSetups";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { PUBLIC_DARK_TOKENS } from "@/components/connect/publicTokens";

export const metadata: Metadata = {
  title: "Connect your AI agent to lnkdrp",
  description:
    "Set up lnkdrp as an MCP server in Claude Code, Cursor, Codex, Gemini CLI, Cowork, Grok or any MCP client. Your agent creates share links and reads who opened them.",
  alternates: { canonical: "/mcp" },
};

/** Render the public MCP overview. */
export default function McpOverviewPage() {
  return (
    // The pricing frame, like /pricing, /credits and /costs: this is the page a visitor lands on
    // from the header's "Connect your agent", and it should not feel like a different site.
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />

        <section className="mx-auto w-full max-w-6xl flex-1 px-8 pb-20 pt-12 sm:px-10 md:pt-16 lg:px-12" style={PUBLIC_DARK_TOKENS}>
          <div className="max-w-2xl">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">MCP</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
              Connect your AI agent
            </h1>
            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
        lnkdrp is an MCP server at <code className="font-mono text-[0.92em] text-white/80">{MCP_URL}</code>. Add it to your client,
        sign in when it asks, and your agent creates share links, sets passwords and reads the numbers. No key to paste; a key is
        there for scripts and for clients that cannot sign in.
            </p>
          </div>

          <h2 className="mt-14 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Pick your client</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 md:gap-5">
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

          <h2 className="mt-16 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">{MULTIPLE_WORKSPACES.title}</h2>
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
            <p className="max-w-2xl text-sm leading-6 text-white/70">{MULTIPLE_WORKSPACES.body}</p>
          </div>

          <div className="mt-16 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">What your agent can do</h2>
            <span className="text-[11px] font-medium tracking-wide text-white/35">Ships with launch</span>
          </div>
          <div className="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
            <ToolCatalogTable />
          </div>

          <div className="mt-16 rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
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
        </section>

        <PublicFooter className="relative pb-6" />
      </div>
    </main>
  );
}
