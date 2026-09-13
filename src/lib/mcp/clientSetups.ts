/**
 * Single source of truth for "connect your agent" content: the MCP server URL, the verification
 * endpoint, and one setup entry per supported MCP client.
 *
 * Consumed by the homepage panel (`McpInstallExample`), the in-app Connect page (`/connect`) and
 * the public guides (`/mcp`, `/mcp/[client]`). Every command takes the key as a parameter so the
 * Connect page can render a freshly created key inline while public pages use `KEY_PLACEHOLDER`.
 *
 * Copy rules: no em-dashes; the MCP server "ships with launch"; the verification endpoint works today.
 */

/** Production MCP endpoint; override with NEXT_PUBLIC_MCP_URL (build-time) for staging or a local server. */
export const MCP_URL = (process.env.NEXT_PUBLIC_MCP_URL || "https://mcp.lnkdrp.com/mcp").replace(/\/+$/, "");
/** Where a locally run MCP server listens by default (`MCP_PORT` in the MCP server's env). */
export const DEV_MCP_URL = "http://localhost:8787/mcp";

/**
 * The MCP endpoint to show on a page running at `origin`: the env override when set, the local
 * default when the page is not on the public site (a dev server), else production. Keeps every
 * command on `/connect` consistent with the server you are actually on.
 */
export function mcpUrlForOrigin(origin: string): string {
  if (process.env.NEXT_PUBLIC_MCP_URL) return MCP_URL;
  return origin.replace(/\/+$/, "") === SITE_ORIGIN ? MCP_URL : DEV_MCP_URL;
}
/** Public site origin for docs and the verification command (build-time; falls back to production). */
export const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://lnkdrp.com").replace(/\/+$/, "");
export const WHOAMI_PATH = "/api/agent/whoami";
export const WHOAMI_URL = `${SITE_ORIGIN}${WHOAMI_PATH}`;
export const KEY_PLACEHOLDER = "lnk_your_key_here";
/** Shown on the public guides as "Last updated". Bump when a client's steps change. */
export const GUIDES_LAST_UPDATED = "September 13, 2026";

export type ClientKey = "claude" | "cowork" | "cursor" | "codex" | "gemini" | "grok" | "json";
export type ClientSetupKind = "cli" | "ui" | "json";

/** One numbered step on a public guide. `code` lines are rendered in a copyable block. */
export type SetupStep = { title: string; body?: string; code?: string[] };

export type ClientSetup = {
  key: ClientKey;
  /** URL segment for the public guide: `/mcp/<slug>`. */
  slug: string;
  label: string;
  kind: ClientSetupKind;
  /** One sentence for the client card on `/mcp` and the guide lede. */
  blurb: string;
  /** Short note under the compact tab view on `/connect`. */
  note: string;
  /** Vendor documentation for MCP setup, when it exists. */
  docsUrl?: string;
  /** Compact install snippet for the tab view (homepage and `/connect`). */
  lines: (key: string, mcpUrl?: string) => string[];
  /**
   * Client-specific steps for the public guide. The guide adds "Create a key" before these and
   * "Verify" after them, so these cover only adding the server to the client.
   */
  steps: (key: string, mcpUrl?: string) => SetupStep[];
  /** For JSON-config clients: the object to paste when `mcpServers` already has other entries. */
  mergeSnippet?: (key: string, mcpUrl?: string) => string[];
};

/** The `lnkdrp` entry inside an `mcpServers` object, at the given base indent. */
function jsonEntry(key: string, indent: string, mcp: string = MCP_URL): string[] {
  return [
    `${indent}"lnkdrp": {`,
    `${indent}  "url": "${mcp}",`,
    `${indent}  "headers": { "Authorization": "Bearer ${key}" }`,
    `${indent}}`,
  ];
}

/** A complete `mcpServers` config containing only lnkdrp. */
function jsonConfig(key: string, mcp: string = MCP_URL): string[] {
  return ["{", '  "mcpServers": {', ...jsonEntry(key, "    ", mcp), "  }", "}"];
}

/** UI-style "fill in these fields" lines used by clients without a CLI or config file. */
function uiFields(key: string, mcp: string = MCP_URL): string[] {
  return ["name   lnkdrp", `url    ${mcp}`, `auth   Bearer ${key}`];
}

export const CLIENT_SETUPS: ClientSetup[] = [
  {
    key: "claude",
    slug: "claude-code",
    label: "Claude Code",
    kind: "cli",
    blurb: "One command in a terminal. Claude Code talks to lnkdrp over HTTP with your key.",
    note: "Run this in a terminal. Add --scope user to make it available in every project.",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/mcp",
    lines: (key, mcp = MCP_URL) => [`claude mcp add --transport http lnkdrp ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Add lnkdrp to Claude Code",
        body: "Run this in a terminal. By default it registers the server for the project you run it from; add --scope user to make it available everywhere.",
        code: [`claude mcp add --transport http lnkdrp ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
      },
      {
        title: "Check it registered",
        body: "Run claude mcp list and look for lnkdrp. Inside a session, /mcp shows the connection state.",
        code: ["claude mcp list"],
      },
    ],
  },
  {
    key: "cowork",
    slug: "cowork",
    label: "Cowork",
    kind: "ui",
    blurb: "Add lnkdrp as a connector from Cowork's settings. No terminal needed.",
    note: "Fill in these fields when Cowork asks for the server details.",
    lines: (key, mcp = MCP_URL) => ["Cowork › Settings › Connectors › Add MCP server", ...uiFields(key, mcp)],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Open Connectors",
        body: "In Cowork, open Settings, then Connectors, then Add MCP server.",
      },
      {
        title: "Enter the server details",
        body: "Use lnkdrp as the name, the URL below as the server address, and your key as a bearer token.",
        code: uiFields(key, mcp),
      },
    ],
  },
  {
    key: "cursor",
    slug: "cursor",
    label: "Cursor",
    kind: "json",
    blurb: "A few lines in Cursor's mcp.json. Works globally or per project.",
    note: "Cursor stores servers in ~/.cursor/mcp.json (or .cursor/mcp.json inside a project).",
    docsUrl: "https://docs.cursor.com/context/mcp",
    lines: (key, mcp = MCP_URL) => ["Settings › MCP › Add server", ...uiFields(key, mcp)],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Open Cursor's MCP settings",
        body: "Open Cursor Settings, then MCP, then Add new global MCP server. This opens ~/.cursor/mcp.json. Use .cursor/mcp.json inside a project to scope the server to that project.",
      },
      {
        title: "Add the lnkdrp server",
        body: "Paste this if the file is empty. Save, and Cursor shows a green dot next to lnkdrp once it connects.",
        code: jsonConfig(key, mcp),
      },
    ],
    mergeSnippet: (key, mcp = MCP_URL) => jsonEntry(key, "", mcp),
  },
  {
    key: "codex",
    slug: "codex",
    label: "Codex",
    kind: "cli",
    blurb: "One command in a terminal. Codex keeps the server in its config file.",
    note: "Run this in a terminal. Codex stores it in ~/.codex/config.toml.",
    docsUrl: "https://developers.openai.com/codex/mcp",
    lines: (key, mcp = MCP_URL) => [`codex mcp add lnkdrp --url ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Add lnkdrp to Codex",
        body: "Run this in a terminal. Codex stores the server in ~/.codex/config.toml.",
        code: [`codex mcp add lnkdrp --url ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
      },
      {
        title: "Check it registered",
        body: "Run codex mcp list and look for lnkdrp.",
        code: ["codex mcp list"],
      },
    ],
  },
  {
    key: "gemini",
    slug: "gemini-cli",
    label: "Gemini CLI",
    kind: "cli",
    blurb: "One command in a terminal. Gemini CLI connects over HTTP with your key.",
    note: "Run this in a terminal. Gemini CLI stores it in ~/.gemini/settings.json.",
    docsUrl: "https://geminicli.com/docs/tools/mcp-server/",
    lines: (key, mcp = MCP_URL) => [`gemini mcp add --transport http lnkdrp ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Add lnkdrp to Gemini CLI",
        body: "Run this in a terminal. Gemini CLI stores the server in ~/.gemini/settings.json.",
        code: [`gemini mcp add --transport http lnkdrp ${mcp} \\`, `  --header "Authorization: Bearer ${key}"`],
      },
      {
        title: "Check it registered",
        body: "Run gemini mcp list, or /mcp inside a session, and look for lnkdrp.",
        code: ["gemini mcp list"],
      },
    ],
  },
  {
    key: "grok",
    slug: "grok",
    label: "Grok",
    kind: "ui",
    blurb: "Add lnkdrp as a tool from Grok's settings. No terminal needed.",
    note: "Fill in these fields when Grok asks for the server details.",
    lines: (key, mcp = MCP_URL) => ["Grok › Settings › Tools › Add MCP server", ...uiFields(key, mcp)],
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Open Tools",
        body: "In Grok, open Settings, then Tools, then Add MCP server.",
      },
      {
        title: "Enter the server details",
        body: "Use lnkdrp as the name, the URL below as the server address, and your key as a bearer token.",
        code: uiFields(key, mcp),
      },
    ],
  },
  {
    key: "json",
    slug: "any-client",
    label: "Any client",
    kind: "json",
    blurb: "Any MCP client that reads an mcpServers config. Streamable HTTP with a bearer token.",
    note: "lnkdrp is a remote server over streamable HTTP, so there is no local process to install.",
    lines: (key, mcp = MCP_URL) => jsonConfig(key, mcp),
    steps: (key, mcp = MCP_URL) => [
      {
        title: "Add the server to your client's MCP config",
        body: "Most clients read an mcpServers object from a JSON file. lnkdrp is a remote server over streamable HTTP with a bearer token, so there is no local process to install. Check your client's docs for where the file lives.",
        code: jsonConfig(key, mcp),
      },
    ],
    mergeSnippet: (key, mcp = MCP_URL) => jsonEntry(key, "", mcp),
  },
];

/** Look up a client setup by its public-guide slug. */
export function findClientSetup(slug: string): ClientSetup | undefined {
  return CLIENT_SETUPS.find((c) => c.slug === slug);
}

/** The verification request: works today, before the MCP server ships. */
export function whoamiCurl(key: string, origin: string = SITE_ORIGIN): string[] {
  // `origin` lets the in-app page point at the server it is running on (a dev server's key is only
  // known to that server); the public guides use the site origin.
  return [`curl -s ${origin.replace(/\/+$/, "")}${WHOAMI_PATH} \\`, `  -H "Authorization: Bearer ${key}" \\`, `  -H "x-lnkdrp-agent: curl/1"`];
}

/** The prompt a user can paste into their agent to verify the connection end to end. */
export const ASK_YOUR_AGENT = "Call lnkdrp_whoami and tell me which workspace you are connected to.";

/** The MCP tool catalog (docs/prds/lnkdrp-mcp.md, "Tool catalog"). Ships with launch. */
export type ToolCatalogEntry = { name: string; purpose: string; access: "read" | "write" };

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "lnkdrp_whoami", purpose: "Which workspace, plan and key the agent is using.", access: "read" },
  { name: "lnkdrp_share_pdf", purpose: "Create a share link from a PDF URL, with optional password, download control and summary.", access: "write" },
  { name: "lnkdrp_get_share", purpose: "Status, settings and summary of a link. Poll it after share_pdf.", access: "read" },
  { name: "lnkdrp_set_share_access", purpose: "Turn sharing, downloads or the password on or off for a link.", access: "write" },
  { name: "lnkdrp_get_share_stats", purpose: "Views, downloads and viewers for a link over a window of days.", access: "read" },
];

/** Short answers to the questions people hit first. Shared by `/connect` and the public guides. */
export const TROUBLESHOOTING: Array<{ q: string; a: string }> = [
  {
    q: "I get 401 unauthorized.",
    a: "The key was revoked, or it was pasted with a space or line break. Keys start with lnk_ and are 36 characters. Create a new one if in doubt; revoking the old one is safe.",
  },
  {
    q: "The agent sees the wrong workspace.",
    a: "A key belongs to one workspace. Switch to the workspace you want in lnkdrp, create a key there, and use that one in your client.",
  },
  {
    q: "How does lnkdrp know which client connected?",
    a: "Clients identify themselves with the x-lnkdrp-agent header, for example claude-code/1.0. MCP clients send it automatically once the server ships; with curl you set it yourself.",
  },
  {
    q: "Can I have more than one key?",
    a: "Yes, up to 10 active keys per workspace. Use one per agent or machine so you can revoke a single one without touching the others.",
  },
];
