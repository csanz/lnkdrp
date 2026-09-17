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
  /**
   * How to change the key or remove lnkdrp. Clients keep one server per name, so re-running the add
   * command with a new key fails ("lnkdrp already exists"); the fix is remove, then add again.
   */
  remove: { body: string; code?: string[] };
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
    remove: { body: "Claude Code keeps one server per name, so re-running the add command with a new key fails with \"lnkdrp already exists\". Remove it first, then add it again with the new key. Add -s user if you registered it with --scope user.", code: ["claude mcp remove lnkdrp"] },
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
    remove: { body: "Open Cowork › Settings › Connectors, pick lnkdrp, and either paste the new token into the auth field or remove the connector." },
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
    remove: { body: "Edit the same mcp.json: replace the value after \"Bearer \" with the new key, or delete the \"lnkdrp\" entry. Cursor reloads the file when you save." },
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
    remove: { body: "Codex keeps one server per name. Remove lnkdrp, then add it again with the new key.", code: ["codex mcp remove lnkdrp"] },
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
    remove: { body: "Gemini CLI keeps one server per name. Remove lnkdrp, then add it again with the new key.", code: ["gemini mcp remove lnkdrp"] },
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
    remove: { body: "Open Grok › Settings › Tools, pick lnkdrp, and either paste the new token or remove the tool." },
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
    remove: { body: "Edit the \"lnkdrp\" entry in your client's config: replace the Bearer value with the new key, or delete the entry. Restart the client if it does not watch the file." },
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

/**
 * The MCP tool catalog: the single source of truth for what each tool does, on the web.
 *
 * Rendered by `/connect` (signed in) and the public `/mcp` pages. Every tool carries its full
 * reference — inputs, output, errors, and whether it confirms with the human — not only a
 * one-liner, because until this the only place a person could read what a tool took and returned
 * was `docs/MCP.md`, a repo file no user ever sees. Two copies of the same reference drift; this
 * one is the copy, and `docs/MCP.md` is the developer-facing long form that must agree with it.
 *
 * `purpose` is the one line a scanner reads. `detail` is what opens when they want more.
 */
export type ToolCatalogEntry = {
  name: string;
  purpose: string;
  access: "read" | "write";
  /** True for tools that ask the human before doing anything irreversible. */
  confirms?: boolean;
  detail: {
    /** Each input, as `name — what it is`. Optional ones say so. */
    inputs: string[];
    /** What comes back, in one or two sentences. */
    output: string;
    /** Error codes an agent should expect, as `code — when`. */
    errors: string[];
    /** One thing worth knowing that the inputs and output do not say. */
    note?: string;
  };
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "lnkdrp_whoami",
    purpose: "Which workspace, plan and key the agent is using.",
    access: "read",
    detail: {
      inputs: ["none"],
      output: "Your user id and email, the workspace id and name, plan (free or pro), the key's prefix and scopes, the client name lnkdrp recorded, credits remaining and when they reset, whether the workspace can be billed for on-demand credits (onDemand), the credit cost per AI action by tier, and a capabilities object answering \"what can I do here\" in one call: document/project/collaborator caps with what's used and left, whether links are ever limited (they're not), the analytics window, whether recipients can browse prior versions, and which product features (request repos, download-access requests) have no MCP tool at all yet.",
      errors: ["unauthorized — the key is missing or invalid", "key_revoked — the key was revoked"],
      note: "Call it first to confirm the connection; it costs nothing.",
    },
  },
  {
    name: "lnkdrp_list_docs",
    purpose: "Find documents by title, by any share-link slug, or by id.",
    access: "read",
    detail: {
      inputs: [
        "query — optional; matches document titles and the slug of any share link on the document",
        "ids — optional; up to 50 document ids to fetch directly (query and page are then ignored)",
        "page — optional, default 1",
        "limit — optional, 1 to 50, default 25",
      ],
      output: "total, page, limit, hasMore and the matching documents: id, default shareId and shareUrl, title, one-line summary, processing status, version and dates. Archived and deleted documents are left out.",
      errors: ["validation — a malformed id or an out-of-range page or limit"],
      note: "This is how an agent finds a document it was not handed. Pair a result's id with get_share, list_share_links or get_share_stats.",
    },
  },
  {
    name: "lnkdrp_get_activity",
    purpose: "The workspace activity feed: uploads, link changes, views, downloads, plan and agent events.",
    access: "read",
    detail: {
      inputs: [
        "limit — optional, 1 to 100, default 40",
        "cursor — optional; the nextCursor from the previous page",
        "types — optional; only these event types, e.g. share.viewed, share_link.created, doc.archived",
        "docId — optional; only events on one document",
        "who — optional; agents (anything done by any MCP or API client), me (the key owner in the app) or team (other members)",
      ],
      output: "items newest first — each with type, time, who acted (and which agent client, if any), the document and project it concerns, and the event's payload — plus nextCursor for the next page.",
      errors: ["validation — an unknown event type, a malformed cursor or an out-of-range limit"],
      note: "who: agents is the audit trail for agents, including this one. On Free, viewer names and emails are withheld from share.viewed and share.downloaded rows, as in the app.",
    },
  },
  {
    name: "lnkdrp_share_pdf",
    purpose: "Create a share link from a PDF URL, with optional password, download control and summary.",
    access: "write",
    detail: {
      inputs: [
        "idempotencyKey — required; reuse it on retries and you get the same document back",
        "sourceUrl — an https URL to a PDF, up to 25 MB; Google Drive links to a PDF file are accepted, but Google Docs/Slides editor links and OneDrive/SharePoint links are refused (download the PDF and use fileBase64). Exactly one of sourceUrl / fileBase64",
        "fileBase64 — the PDF's bytes, base64-encoded, for a file with no public URL (decoded size up to 3 MB)",
        "fileName — optional, only used with fileBase64",
        "title — optional, up to 200 characters",
        "allowDownload — optional, default off",
        "password — optional, 1–128 characters",
        "waitForReady / timeoutSeconds — optional; wait for processing (default 60s, max 120s)",
        "summary + keyPoints — optional, both or neither; when the agent writes them the AI summary is skipped and costs 0 credits",
      ],
      output: "docId, shareId, the shareUrl (valid at once, even while processing), status, version, uploadId, and any AI steps that were skipped as warnings.",
      errors: [
        "plan_limit — the Free plan's shared-document cap; the error lists what you can still do without upgrading",
        "out_of_credits — the AI summary needs credits the workspace does not have; pass summary and keyPoints instead",
        "fetch_blocked / unsupported_content_type / too_large — the URL or file could not be used",
        "validation — including invalid_summary, whose message says how to fix it",
      ],
      note: "Every upload's automatic summary costs 1 credit unless the agent supplies its own.",
    },
  },
  {
    name: "lnkdrp_replace_pdf",
    purpose: "Put a new PDF on a document you already shared — every link keeps working.",
    access: "write",
    detail: {
      inputs: [
        "idempotencyKey — required; reuse it on retries and you get the same result back",
        "docId — the existing document to update",
        "sourceUrl — an https URL to the new PDF; Google Drive links to a PDF file are accepted, but Google Docs/Slides editor links and OneDrive/SharePoint links are refused (download the PDF and use fileBase64). Exactly one of sourceUrl / fileBase64",
        "fileBase64 — the new PDF's bytes, base64-encoded, for a file with no public URL (decoded size up to 3 MB)",
        "fileName — optional, only used with fileBase64",
        "title — optional, up to 200 characters; leaves the title unchanged if omitted",
        "waitForReady / timeoutSeconds — optional; wait for processing (default 60s, max 120s)",
        "summary + keyPoints — optional, both or neither; when the agent writes them the AI summary is skipped and costs 0 credits",
      ],
      output: "docId, shareId, shareUrl, status, the new version number, uploadId, and any AI steps that were skipped as warnings.",
      errors: [
        "not_found — the docId does not exist in this workspace",
        "out_of_credits — the AI summary needs credits the workspace does not have; pass summary and keyPoints instead",
        "fetch_blocked / unsupported_content_type / too_large — the URL or file could not be used",
        "validation — including invalid_summary, whose message says how to fix it",
      ],
      note: "Never blocked by the document cap — replacing does not create a document. The status flips to preparing as soon as the call starts, before the new file is fetched.",
    },
  },
  {
    name: "lnkdrp_get_share",
    purpose: "Status, settings and summary of a link. Poll it after share_pdf.",
    access: "read",
    detail: {
      inputs: ["docId or shareId — exactly one; any of a document's links resolves"],
      output: "Processing status, whether sharing is on, download/password/version-history settings, the share URL, preview image, and the AI one-liner and summary once ready. Asked about a specific link, it reports that link's own settings and a link block naming it.",
      errors: ["validation — none or both ids given", "not_found — unknown id, or a document in another workspace"],
    },
  },
  {
    name: "lnkdrp_set_share_access",
    purpose: "Turn sharing, downloads or the password on or off for a link.",
    access: "write",
    detail: {
      inputs: ["idempotencyKey — required", "docId", "shareEnabled / allowDownload — optional booleans", "password — a string to set, null to remove", "allowRevisionHistory — optional; letting recipients browse versions is Pro"],
      output: "The same shape as lnkdrp_get_share, after the change.",
      errors: ["plan_limit — turning sharing on at the Free shared-document cap, or version history on Free", "forbidden — a read-only key", "not_found"],
    },
  },
  {
    name: "lnkdrp_get_share_stats",
    purpose: "Views, downloads and viewers for a link over a window of days.",
    access: "read",
    detail: {
      inputs: ["docId and/or shareId — a shareId scopes everything to that one link; a docId covers all its links", "days — 1–60, default 15; Free is clamped to 7", "includeViewers — per-viewer rows with per-page time (Pro only)"],
      output: "Totals for views, opens, downloads, pages viewed and time spent, a unique viewer count, a per-day series, and — on Pro with includeViewers — every reader with their pages and time on each page. Owner and teammate opens are excluded from every figure and counted separately as ownerPreviews.",
      errors: ["validation", "not_found"],
      note: "views counts recipients; opens counts sittings. A reader who came back three times is one view and three opens.",
    },
  },
  {
    name: "lnkdrp_create_share_link",
    purpose: "Add another link to a document, one per recipient, with its own label, password and expiry.",
    access: "write",
    detail: {
      inputs: ["docId", "label — private name, 1–80 characters, never shown to viewers", "audience — optional private note, up to 120 characters", "allowDownload / allowRevisionHistory — optional", "password — optional, 1–128 characters", "expiresAt — optional ISO date in the future", "enabled — optional, default on"],
      output: "The new link with its own shareUrl, working immediately.",
      errors: ["validation — missing label, past expiry, short password", "not_found — the document"],
      note: "Links are never plan-capped. A document may carry one per investor or counterparty on any plan.",
    },
  },
  {
    name: "lnkdrp_list_share_links",
    purpose: "Every link of a document with its settings, status and view counts — or search its links by name.",
    access: "read",
    detail: {
      inputs: ["docId", "query — optional; full-text search this document's links by label/audience, ranked by relevance"],
      output: "Every link (or, with query, only the matches), default first: label, audience, shareUrl, status (active, disabled, expired), password and expiry state, and that link's viewer and download counts.",
      errors: ["not_found"],
      note: "Don't know which document a link is on? lnkdrp_find_share_link searches by name across the whole workspace.",
    },
  },
  {
    name: "lnkdrp_find_share_link",
    purpose: "Find a share link by name (its label or audience) across the whole workspace.",
    access: "read",
    detail: {
      inputs: ["query — the name to search for, e.g. \"a16z\" or \"Sequoia\"", "limit — optional, 1 to 50, default 20"],
      output: "The matching links, ranked by relevance: which document each is on (id, title, default shareId), the link's own id, shareId, shareUrl, label, audience and whether it's the default link.",
      errors: [],
      note: "Backed by a MongoDB text index: whole-word matches only (\"a16z\" matches, \"nest\" does not), fast at any workspace size. Returns [] rather than an error when nothing matches.",
    },
  },
  {
    name: "lnkdrp_verify_share_password",
    purpose: "Check whether a password opens a link, without revealing the real one.",
    access: "read",
    detail: {
      inputs: ["docId and linkId", "password — the candidate to test"],
      output: "{ passwordEnabled, matches }. matches is false whenever the link has no password.",
      errors: ["validation", "not_found — unknown link, or a link on another document", "forbidden — owner or admin only", "rate_limited"],
      note: "Safe to call: it never opens the link, records a view, or spends the recipient's 10-tries-per-5-minutes unlock budget. Its own limit is 20 checks per link per 5 minutes.",
    },
  },
  {
    name: "lnkdrp_get_share_link_password",
    purpose: "Show the password set on a link, so an agent can tell the owner what it is later.",
    access: "read",
    detail: {
      inputs: ["docId and linkId"],
      output: "{ passwordEnabled, password }. password is null when the link has none, or when only its hash survives.",
      errors: ["not_found — unknown link, or a link on another document", "forbidden — owner or admin only", "rate_limited"],
      note: "Returns the secret in plain text, so every read writes a workspace activity row. Prefer lnkdrp_verify_share_password when you only need to confirm a password you already have.",
    },
  },
  {
    name: "lnkdrp_update_share_link",
    purpose: "Change or disable one link without touching the document's other links.",
    access: "write",
    detail: {
      inputs: ["linkId and docId", "label / audience / enabled / allowDownload / password / expiresAt / allowRevisionHistory — any of them"],
      output: "The updated link.",
      errors: ["validation", "not_found — unknown link, or a link on another document", "forbidden"],
      note: "Disabling a link revokes one recipient's access instantly; the document's other links are untouched.",
    },
  },
  {
    name: "lnkdrp_delete_share_link",
    purpose: "Delete one link after confirming with you; its past analytics are kept.",
    access: "write",
    confirms: true,
    detail: {
      inputs: ["linkId and docId", "confirm — only for clients that cannot show you a prompt; the agent sets it after you say yes"],
      output: "ok, and what was deleted (link id, shareId, label). The link stops resolving at once and cannot come back; its analytics stay in the document's totals.",
      errors: ["validation — the default link cannot be deleted (disable it instead), or you did not confirm", "not_found"],
      note: "Before acting it shows you the link, how many recipients opened it and when, and asks. It will not proceed without your yes.",
    },
  },
  {
    name: "lnkdrp_archive_doc",
    purpose: "Archive a document to free a slot, or bring it back. Reversible; keeps analytics. Confirms with you first.",
    access: "write",
    confirms: true,
    detail: {
      inputs: ["docId", "archived — true to archive, false to bring it back", "confirm — only for clients that cannot show you a prompt"],
      output: "ok, the document's new archived state, and how many links were affected.",
      errors: ["validation — you did not confirm", "not_found", "plan_limit — unarchiving at the Free shared-document cap"],
      note: "Archiving takes every link on the document down at once and frees a Free-plan slot; everything comes back on unarchive. It asks first because of the blast radius, even though it is reversible.",
    },
  },
  {
    name: "lnkdrp_delete_doc",
    purpose: "Delete a document permanently, after confirming with you. Prefer archive if you might want it back.",
    access: "write",
    confirms: true,
    detail: {
      inputs: ["docId", "confirm — only for clients that cannot show you a prompt"],
      output: "ok, and what was deleted (document id, title, how many links).",
      errors: ["validation — still processing, or you did not confirm", "not_found"],
      note: "Permanent from the owner's side: the document, its file and every link disappear. It shows you the document, its links and traffic first, and will not proceed without your yes.",
    },
  },
  {
    name: "lnkdrp_create_project",
    purpose: "Create a project to group documents, such as a data room for one deal.",
    access: "write",
    detail: {
      inputs: [
        "idempotencyKey — required; reuse it on retries and you get the same project back",
        "name — 1 to 80 characters, unique in the workspace",
        "description — optional; shown on the project's public page",
      ],
      output: "The project: id, slug, name, description, document count, its page in the app, and its public page URL.",
      errors: [
        "plan_limit — the Free plan's project cap; the error lists what you can still do without upgrading",
        "validation — a missing or too-long name, or a name another project already uses",
      ],
      note: "A new project's public page is on from the start and lists every document you add whose link is on. Turn it off with update_project if you don't want it.",
    },
  },
  {
    name: "lnkdrp_list_projects",
    purpose: "List the workspace's projects, or search them by name.",
    access: "read",
    detail: {
      inputs: [
        "query — optional; matches project names and descriptions",
        "page — optional, default 1",
        "limit — optional, 1 to 50, default 25",
      ],
      output: "total, page, limit, hasMore and the projects, most recently updated first: id, slug, name, description, document count, app URL and dates.",
      errors: ["validation — an out-of-range page or limit"],
    },
  },
  {
    name: "lnkdrp_get_project",
    purpose: "One project and a page of its documents.",
    access: "read",
    detail: {
      inputs: [
        "projectId or projectSlug — exactly one",
        "query — optional; only documents whose title or link slug matches",
        "page — optional, default 1",
        "limit — optional, 1 to 50, default 25",
      ],
      output: "The project (id, slug, name, description, document count, app URL, whether its public page is on and its URL) and its documents: id, shareId and share URL, title, status, version and dates. Archived documents are left out.",
      errors: ["not_found — no such project in this workspace", "validation — both or neither of projectId and projectSlug"],
    },
  },
  {
    name: "lnkdrp_add_docs_to_project",
    purpose: "Put documents into a project. A document can be in several projects.",
    access: "write",
    detail: {
      inputs: ["projectId or projectSlug — exactly one", "docIds — 1 to 50 document ids"],
      output: "Which documents were added, which were already in the project, which were not found (unknown, deleted or archived), and any that failed with the reason.",
      errors: ["not_found — no such project in this workspace", "forbidden — a read-only key, or a viewer in the workspace"],
      note: "Safe to retry. While the project's public page is on, added documents whose link is on are listed there.",
    },
  },
  {
    name: "lnkdrp_remove_doc_from_project",
    purpose: "Take a document out of a project. The document itself stays.",
    access: "write",
    detail: {
      inputs: ["projectId or projectSlug — exactly one", "docId"],
      output: "Whether it was removed, whether it was in the project at all, and the projects it is still in.",
      errors: ["not_found — no such project or document in this workspace"],
      note: "Not a delete: the document, its links, their analytics and its other projects are untouched, so it doesn't ask first.",
    },
  },
  {
    name: "lnkdrp_update_project",
    purpose: "Rename a project, change its description, or turn its public page on or off.",
    access: "write",
    detail: {
      inputs: [
        "projectId or projectSlug — exactly one",
        "name — optional, 1 to 80 characters",
        "description — optional; an empty string clears it",
        "publicPageEnabled — optional; whether the project's public page works",
      ],
      output: "The updated project.",
      errors: ["validation — nothing to change, or a name another project already uses", "not_found"],
      note: "Anything you don't pass is kept. Renaming keeps the slug and every URL.",
    },
  },
  {
    name: "lnkdrp_delete_project",
    purpose: "Delete a project after confirming with you. Its documents stay in the workspace.",
    access: "write",
    confirms: true,
    detail: {
      inputs: ["projectId or projectSlug — exactly one", "confirm — only for clients that cannot show you a prompt"],
      output: "ok, and what was deleted (project id, slug, how many documents left it).",
      errors: ["validation — you did not confirm", "not_found"],
      note: "Only the project goes: its documents, their links and analytics are kept. Its public page stops working and the project can't be restored. It shows you the project, its document count and whether its public page is live, and will not proceed without your yes.",
    },
  },
];

/** Short answers to the questions people hit first. Shared by `/connect` and the public guides. */
export const TROUBLESHOOTING: Array<{ q: string; a: string }> = [
  {
    q: "My client says lnkdrp already exists.",
    a: "Each client keeps one server per name, so adding again with a new key is refused. Remove the old lnkdrp entry first (the command or setting is under \"Change the key or remove lnkdrp\" for your client), then add it again with the new key.",
  },
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
