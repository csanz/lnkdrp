"use client";

import Link from "next/link";
import { useState } from "react";

import { CLIENT_SETUPS, KEY_PLACEHOLDER, type ClientKey } from "@/lib/mcp/clientSetups";

/**
 * Homepage example of connecting an AI agent to LinkDrop over MCP.
 *
 * The install snippets come from `src/lib/mcp/clientSetups.ts` (shared with `/connect` and the
 * public `/mcp` guides) rendered with the placeholder key; the exchange below is illustrative.
 */

const CLIENTS = CLIENT_SETUPS.map((c) => ({ key: c.key, label: c.label, lines: c.lines(KEY_PLACEHOLDER) }));

const EXCHANGE: Array<{ who: "you" | "agent"; text: string }> = [
  {
    who: "you",
    // Non-breaking spaces keep the proper nouns on one line when text-balance wraps on phones.
    text: "Create a link to the Series\u00A0A memo for Priya at Larkspur, allow downloads, and expire it in a week. Then send it to her in Superhuman with the new-investor template.",
  },
  {
    who: "agent",
    text: "Done. Priya’s link is lnkdrp.com/s/8Kq2Vt7Lm9Xa, downloads on, expires next Wednesday. Sent from Superhuman with the new-investor template, and the link stays hers if you write to her again.",
  },
  { who: "you", text: "Has she opened it?" },
  {
    who: "agent",
    text: "Twice, last night and again this morning, eleven minutes in total. Most of it went to pages 2 and 7, she downloaded it on the second visit, and a summary is in your inbox.",
  },
  {
    who: "agent",
    // A second turn from the agent, unprompted: the workspace changed under the link and it noticed.
    text: "By the way, Daniel updated the memo an hour ago. Want to see what changed?",
  },
];

/** Render the homepage "Connect your agent" panel. */
export default function McpInstallExample() {
  const [client, setClient] = useState<ClientKey>("claude");
  const [copied, setCopied] = useState(false);
  const active = CLIENTS.find((c) => c.key === client) ?? CLIENTS[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(active.lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); the text stays selectable.
    }
  };

  return (
    <section aria-label="Connect your AI agent" className="mt-12 w-full max-w-xl md:mt-20 md:max-w-none">
      {/* Below sm the note takes its own row directly under the h2 (left-set, like the lede);
          from sm up it shares the h2's row and right-aligns. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-serif text-[24px] leading-[1.15] tracking-tight text-white/90 md:text-[28px]">Connect your agent</h2>
        <span className="basis-full text-[11px] font-medium tracking-wide text-white/35 sm:ml-auto sm:basis-auto">
          Example · ships with launch
        </span>
      </div>
      <p className="mt-3 max-w-md text-pretty text-sm leading-6 text-white/55">
        It takes one line in your MCP client. After that, your agent creates links and reads the numbers.{" "}
        {/* This panel is one client's one line. The full guide is every client, every tool and
            what each one asks before it acts — the thing a reader who is about to paste a key
            into an agent wants to have read. */}
        <Link href="/mcp" className="whitespace-nowrap font-medium text-white/80 underline-offset-4 hover:underline">
          Full guide, every client and tool →
        </Link>
      </p>

      <div className="mt-6 rounded-2xl bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-px">
        <div className="relative rounded-[15px] bg-[#0a0a0c]/80 px-5 pb-5 pt-4">
          {/* Copy is pinned bottom-right, on the snippet's last line box, so it never reads as an
              eighth tab and the tab row can wrap into balanced rows on small screens. */}
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4" role="tablist" aria-label="MCP client">
              {CLIENTS.map((c) => {
                const selected = c.key === client;
                return (
                  <button
                    key={c.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setClient(c.key)}
                    className={[
                      "-mb-px border-b pb-1 text-[12px] font-medium tracking-wide transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30",
                      selected ? "border-white/70 text-white/90" : "border-transparent text-white/40 hover:text-white/70",
                    ].join(" ")}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => void copy()}
              className="absolute bottom-5 right-5 shrink-0 text-[11px] font-semibold uppercase leading-6 tracking-[0.16em] text-white/40 transition hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {/* pre-wrap only wraps a line that does not fit, so the snippet never clips at the panel edge.
              From sm up the right padding reserves the last line's end for the Copy affordance. On
              phones there is no padding so the first install line keeps its full measure; every
              client's wrapped last line still ends well short of Copy there. Each line is its own block with
              a hanging indent so a wrapped continuation tucks under its flag instead of reading as a new
              command; copy() joins the lines directly, so the clipboard text is unaffected. */}
          <pre className="mt-4 whitespace-pre-wrap break-words pr-0 font-mono text-[12px] leading-6 text-white/75 sm:pr-14 sm:text-[12.5px]">
            <code>
              {active.lines.map((l, i) => (
                <span key={i} className="block pl-5 -indent-5">
                  {l}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>

      <dl className="mt-9 space-y-4">
        {EXCHANGE.map((line, i) => (
          <div key={i} className="grid grid-cols-1 gap-y-1.5 sm:grid-cols-[3.25rem_1fr] sm:gap-x-3 sm:gap-y-0">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45 sm:pt-[3px]">
              {/* A speaker who goes on talking is not re-announced; the gutter keeps the column. */}
              {i > 0 && EXCHANGE[i - 1].who === line.who ? <span className="sr-only">{line.who === "you" ? "You" : "Agent"}</span> : line.who === "you" ? "You" : "Agent"}
            </dt>
            <dd
              className={
                // Both speakers share one left edge: You carries the same hairline gutter, transparent.
                line.who === "you"
                  ? "m-0 border-l border-transparent pl-4 text-balance font-serif text-[15.5px] leading-[1.6] text-white/85"
                  : "m-0 border-l border-white/15 pl-4 text-sm leading-6 text-white/60"
              }
            >
              {line.text}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
