/**
 * Public guide at `/mcp/[client]`: "How to connect <Client> to lnkdrp".
 *
 * Numbered steps (create a key, the client's own steps from `CLIENT_SETUPS`, verify), the merge
 * snippet for JSON-config clients, troubleshooting, last-updated line and links back to `/mcp`
 * and `/connect`. Statically generated for every entry in `CLIENT_SETUPS`.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import CodeBlock from "@/components/connect/CodeBlock";
import Troubleshooting from "@/components/connect/Troubleshooting";
import {
  ASK_YOUR_AGENT,
  CLIENT_SETUPS,
  DEFAULT_SERVER_NAME,
  GUIDES_LAST_UPDATED,
  KEY_PLACEHOLDER,
  MCP_URL,
  MULTIPLE_WORKSPACES,
  findClientSetup,
  whoamiCurl,
  type SetupStep,
} from "@/lib/mcp/clientSetups";
import PublicGuideShell from "@/components/connect/PublicGuideShell";

type Params = { client: string };

/** One static page per client in `CLIENT_SETUPS`. */
export function generateStaticParams(): Params[] {
  return CLIENT_SETUPS.map((c) => ({ client: c.slug }));
}

export const dynamicParams = false;

/** Title and description per client. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { client } = await params;
  const setup = findClientSetup(client);
  if (!setup) return {};
  const title = `How to connect ${setup.label} to lnkdrp`;
  const description = `${setup.blurb} Create a key, add the lnkdrp MCP server to ${setup.label}, and verify the connection.`;
  return {
    title,
    description,
    alternates: { canonical: `/mcp/${setup.slug}` },
    openGraph: { title: `${title} - LinkDrop`, description, type: "article" },
    twitter: { title: `${title} - LinkDrop`, description },
  };
}

/** One numbered step: circle with the number, title, and the step's content. */
function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/20 text-[12px] font-semibold tabular-nums text-white/80"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-semibold text-white">{title}</h2>
        {children}
      </div>
    </li>
  );
}

/** Body paragraph under a step title. */
function StepBody({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-sm leading-6 text-white/60">{children}</p>;
}

/** Render the guide for one client, or 404 for an unknown slug. */
export default async function McpClientGuidePage({ params }: { params: Promise<Params> }) {
  const { client } = await params;
  const setup = findClientSetup(client);
  if (!setup) notFound();

  const clientSteps: SetupStep[] = setup.steps(KEY_PLACEHOLDER);
  const merge = setup.mergeSnippet?.(KEY_PLACEHOLDER) ?? null;
  const removal = setup.remove();
  const verifyIndex = clientSteps.length + 2;

  return (
    <PublicGuideShell>
      <Link href="/mcp" className="text-[12px] font-medium text-white/50 underline-offset-4 hover:text-white hover:underline">
        ← All clients
      </Link>
      <p className="mb-4 mt-6 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">MCP guide</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">How to connect {setup.label} to lnkdrp</h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">{setup.blurb}</p>
      <p className="mt-3 text-[12px] text-white/35">Last updated: {GUIDES_LAST_UPDATED}</p>

      <ol className="mt-10 space-y-8">
        <Step n={1} title="Create a key">
          <StepBody>
            <Link href="/connect" className="font-medium text-white underline-offset-4 hover:underline">
              Sign in and open Connect
            </Link>
            , then create a key named for this machine. It is shown once, so copy it right away. Keys start with{" "}
            <code className="font-mono text-[0.92em] text-white/80">lnk_</code> and belong to one workspace.
          </StepBody>
        </Step>

        {clientSteps.map((step, i) => (
          <Step key={step.title} n={i + 2} title={step.title}>
            {step.body ? <StepBody>{step.body}</StepBody> : null}
            {step.code ? (
              <CodeBlock
                lines={step.code}
                label={`Copy ${setup.label} setup`}
                className="mt-3"
              />
            ) : null}
            {step.code && merge && i === clientSteps.length - 1 ? (
              <div className="mt-4">
                <p className="text-sm leading-6 text-white/60">
                  If you already have other servers, add only this entry inside your existing{" "}
                  <code className="font-mono text-[0.92em] text-white/80">mcpServers</code> object:
                </p>
                <CodeBlock lines={merge} label="Copy lnkdrp entry" size="sm" className="mt-2" />
              </div>
            ) : null}
            {step.code?.some((line) => line.includes(KEY_PLACEHOLDER)) ? (
              <p className="mt-2 text-[12px] text-white/40">
                Replace <code className="font-mono">{KEY_PLACEHOLDER}</code> with your key.
              </p>
            ) : null}
          </Step>
        ))}

        <Step n={verifyIndex} title={setup.kind === "cli" ? "Verify" : "Restart and verify"}>
          <StepBody>
            {setup.kind === "cli"
              ? "Check the key itself first. This request works today, before the MCP server ships:"
              : `Restart ${setup.label} so it picks up the new server, then check the key itself. This request works today, before the MCP server ships:`}
          </StepBody>
          <CodeBlock lines={whoamiCurl(KEY_PLACEHOLDER)} label="Copy verification command" className="mt-3" />
          <p className="mt-3 text-sm leading-6 text-white/60">
            Or ask your agent: <span className="text-white/85">“{ASK_YOUR_AGENT}”</span>
          </p>
          <p className="mt-2 text-sm leading-6 text-white/60">
            Back on{" "}
            <Link href="/connect" className="font-medium text-white underline-offset-4 hover:underline">
              Connect
            </Link>
            , the status turns to Connected once the key has been used.
          </p>
        </Step>
      </ol>

      <div className="mt-14">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Change the key or remove lnkdrp</h2>
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-sm leading-6 text-white/70">{removal.body}</p>
          {removal.code ? <CodeBlock lines={removal.code} label={`Copy ${setup.label} remove command`} className="mt-3" /> : null}
        </div>
      </div>

      <div className="mt-14">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">{MULTIPLE_WORKSPACES.title}</h2>
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-sm leading-6 text-white/70">{MULTIPLE_WORKSPACES.body}</p>
          <CodeBlock
            lines={setup.lines(KEY_PLACEHOLDER, MCP_URL, `${DEFAULT_SERVER_NAME}-acme`)}
            label={`Copy ${setup.label} setup for a second workspace`}
            className="mt-3"
          />
          <p className="mt-2 text-[12px] text-white/40">
            Replace <code className="font-mono">{KEY_PLACEHOLDER}</code> with a key created in that workspace. Connect shows the name to use.
          </p>
        </div>
      </div>

      <div className="mt-14">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Troubleshooting</h2>
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <Troubleshooting />
        </div>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <Link href="/connect" className="font-medium text-white underline-offset-4 hover:underline">
          Create a key →
        </Link>
        <Link href="/mcp" className="text-white/60 underline-offset-4 hover:text-white hover:underline">
          Other clients
        </Link>
        {setup.docsUrl ? (
          <a href={setup.docsUrl} target="_blank" rel="noreferrer" className="text-white/60 underline-offset-4 hover:text-white hover:underline">
            {setup.label} MCP docs
          </a>
        ) : null}
      </div>
    </PublicGuideShell>
  );
}
