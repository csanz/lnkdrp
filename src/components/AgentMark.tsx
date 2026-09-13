/**
 * AgentMark — the brand mark of an MCP/agent client, tinted with the current text colour.
 *
 * Marks are monochrome SVGs in `public/agents/` (Simple Icons, CC0) applied as CSS masks over
 * `currentColor`, so one file works in both themes. Unknown clients fall back to a lettered
 * monogram so a row never shows an empty circle. Grok's glyph comes from the Wikimedia Commons
 * app icon with the rounded-square background removed.
 *
 * Client ids follow `AGENT_LABELS` in `src/lib/activity/log.ts` (`claude-code`, `cursor`, …).
 */
import { cn } from "@/lib/cn";

const MARK_BY_CLIENT: Record<string, string> = {
  "claude-code": "/agents/claude.svg",
  "claude-desktop": "/agents/claude.svg",
  claude: "/agents/claude.svg",
  cowork: "/agents/claude.svg",
  cursor: "/agents/cursor.svg",
  codex: "/agents/openai.svg",
  openai: "/agents/openai.svg",
  "gemini-cli": "/agents/gemini.svg",
  gemini: "/agents/gemini.svg",
  windsurf: "/agents/windsurf.svg",
  grok: "/agents/grok.svg",
  cline: "/agents/cline.svg",
};

/** Path of the mark for a client id, or null when we have none. */
export function agentMarkSrc(client: string | null | undefined): string | null {
  if (!client) return null;
  return MARK_BY_CLIENT[client.trim().toLowerCase()] ?? null;
}

/**
 * Render an agent's mark at the given size (Tailwind size classes via `className`, e.g. `h-3.5 w-3.5`).
 * `label` feeds the monogram fallback and the accessible name.
 */
export default function AgentMark({
  client,
  label,
  className,
}: {
  client: string | null | undefined;
  label?: string | null;
  className?: string;
}) {
  const src = agentMarkSrc(client);
  if (src) {
    return (
      <span
        role="img"
        aria-label={label ?? client ?? "Agent"}
        className={cn("inline-block bg-current", className)}
        style={{
          WebkitMaskImage: `url(${src})`,
          maskImage: `url(${src})`,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
    );
  }
  const letter = (label ?? client ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span role="img" aria-label={label ?? client ?? "Agent"} className={cn("inline-grid place-items-center text-[10px] font-semibold leading-none", className)}>
      {letter}
    </span>
  );
}
