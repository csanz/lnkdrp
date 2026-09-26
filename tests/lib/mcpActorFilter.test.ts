/**
 * The MCP's half of contributor pages: one contributor's feed, and the URL that opens it.
 *
 * The point of this feature for an agent is the URL on a row. An agent cannot browse; when a person
 * asks "what has Claude Code been doing in here", the useful answer ends with a link they can open,
 * and that link has to be absolute (the MCP's output is read outside any origin) and has to spell
 * the key the way the app does, or it opens a 404. These tests pin all three: the `actor` filter
 * reaches the API untouched, a key the app could never mint is refused before the API is called at
 * all, and every contributor row carries `key` (what `actor` takes) beside `url` (what a human gets).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient } from "../../mcp/src/api";
import type { ToolContext } from "../../mcp/src/context";
import { registerGetActivityTool } from "../../mcp/src/tools/discover";
import { registerRevisionContributorsTool } from "../../mcp/src/tools/revisions";

const BASE_URL = "https://app.lnkdrp.test";
const OWNER = "6ab46f3a542dc85d9d3ba00f";
const OTHER = "6ab46f3add6983534677931d";
const DOC_ID = "6ab0b66dbaad814de0a8d776";

type Call = { method: string; path: string; query: Record<string, unknown> };

/**
 * A real `ApiClient` with only its transport replaced.
 *
 * Stubbing `request` rather than `listActivity` keeps the query building, the response mapping and
 * `contributorUrl` (the thing that makes a URL absolute) under test instead of mocked away.
 */
function apiWith(body: unknown): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = new ApiClient({ baseUrl: `${BASE_URL}/`, key: `lnk_${"0".repeat(32)}`, agent: () => "test/1" });
  (api as unknown as { request: unknown }).request = async (method: string, path: string, opts: { query?: Record<string, unknown> } = {}) => {
    calls.push({ method, path, query: opts.query ?? {} });
    return body;
  };
  return { api, calls };
}

/** Connect one registrar to an in-memory client; the caller returns the tool's structured output. */
async function connect(register: (server: McpServer, ctx: ToolContext) => void, api: ApiClient) {
  const server = new McpServer({ name: "test", version: "1" });
  register(server, { api, config: {}, whoami: () => ({ orgId: "o1", orgName: "T" }) } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const raw = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await raw(name, args);
    if (res.isError) throw new Error(`tool call failed: ${JSON.stringify(res)}`);
    return res.structuredContent as Record<string, unknown>;
  };
  return { call, raw };
}

/**
 * Did the call fail before it reached the API, however the SDK reports the refusal?
 *
 * A schema rejection comes back as `isError` on the result rather than as a throw, so a test that
 * only caught exceptions would pass while every malformed key sailed through to the route.
 */
async function refused(call: () => Promise<{ isError?: boolean }>): Promise<boolean> {
  try {
    return (await call()).isError === true;
  } catch {
    return true;
  }
}

type ActivityItem = {
  actor: { kind: string; userId: string | null; key: string | null; url: string | null };
  agent: { client: string; key: string | null; url: string | null; ownerUserId: string | null } | null;
};

describe("lnkdrp_get_activity actor", () => {
  it("passes the key through to the API unchanged", async () => {
    const { api, calls } = apiWith({ items: [], nextCursor: null });
    const { call } = await connect(registerGetActivityTool, api);

    await call("lnkdrp_get_activity", { actor: `agent:claude-code@${OWNER}`, limit: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/activity");
    // Reparsing or rewriting the key here could only disagree with the route, which owns what a
    // contributor's feed contains and what `who` means beside it.
    expect(calls[0]!.query.actor).toBe(`agent:claude-code@${OWNER}`);
  });

  it("sends actor and who together and lets the route decide", async () => {
    const { api, calls } = apiWith({ items: [], nextCursor: null });
    const { call } = await connect(registerGetActivityTool, api);

    await call("lnkdrp_get_activity", { actor: `user:${OWNER}`, who: "agents" });

    expect(calls[0]!.query.actor).toBe(`user:${OWNER}`);
    expect(calls[0]!.query.who).toBe("agents");
  });

  it("refuses a key the app could never mint, without calling the API", async () => {
    const { api, calls } = apiWith({ items: [], nextCursor: null });
    const { raw } = await connect(registerGetActivityTool, api);

    // A client id with spaces and capitals: `normalizeClientId` cannot have stored one, so this is
    // a guess, and guesses must not reach Mongo as a filter on nothing.
    expect(await refused(() => raw("lnkdrp_get_activity", { actor: "agent:Claude Code@abc" }))).toBe(true);
    expect(await refused(() => raw("lnkdrp_get_activity", { actor: `user:${OWNER.slice(0, 23)}` }))).toBe(true);
    expect(await refused(() => raw("lnkdrp_get_activity", { actor: "everyone" }))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("gives every addressable row an absolute contributor URL", async () => {
    const { api } = apiWith({
      nextCursor: null,
      items: [
        {
          id: "e1",
          type: "doc.replaced",
          createdDate: "2026-09-20T10:00:00.000Z",
          actor: { userId: OWNER, name: "Christian Sanz", email: "c@example.com", kind: "user" },
          agent: { client: "claude-code", label: "Claude Code", version: "2.1.0" },
          doc: { id: DOC_ID, title: "Deck", shareId: "s1" },
          project: null,
          meta: {},
        },
        {
          id: "e2",
          type: "doc.created",
          createdDate: "2026-09-19T10:00:00.000Z",
          actor: { userId: OTHER, name: "A member", email: null, kind: "user" },
          agent: null,
          doc: null,
          project: null,
          meta: {},
        },
        {
          id: "e3",
          type: "share.viewed",
          createdDate: "2026-09-18T10:00:00.000Z",
          actor: { userId: OTHER, name: null, email: null, kind: "viewer" },
          agent: null,
          doc: null,
          project: null,
          meta: {},
        },
      ],
    });
    const { call } = await connect(registerGetActivityTool, api);

    const out = await call("lnkdrp_get_activity", { limit: 5 });
    const items = out.items as ActivityItem[];

    // An agent's row addresses two pages: the client's, and the member who connected it.
    expect(items[0]!.agent).toMatchObject({ key: `agent:claude-code@${OWNER}`, ownerUserId: OWNER });
    expect(items[0]!.agent!.url).toBe(`${BASE_URL}/agents/claude-code/${OWNER}`);
    expect(items[0]!.actor.key).toBe(`user:${OWNER}`);
    expect(items[0]!.actor.url).toBe(`${BASE_URL}/people/${OWNER}`);

    expect(items[1]!.actor.key).toBe(`user:${OTHER}`);
    expect(items[1]!.actor.url).toBe(`${BASE_URL}/people/${OTHER}`);
    expect(items[1]!.agent).toBeNull();

    // A recipient is not a contributor: their rows are excluded from contributor pages, so a link
    // built from one would open a page that 404s and would read as "this reader works here".
    expect(items[2]!.actor.key).toBeNull();
    expect(items[2]!.actor.url).toBeNull();
  });

  it("prefers the key and href the route sent over anything it could derive", async () => {
    const { api } = apiWith({
      nextCursor: null,
      items: [
        {
          id: "e1",
          type: "share.viewed",
          createdDate: "2026-09-20T10:00:00.000Z",
          // The route withheld the identity (Free), and said so by sending the fields as null.
          actor: { userId: OWNER, name: null, email: null, kind: "user", key: null, href: null },
          agent: null,
          doc: null,
          project: null,
          meta: {},
        },
      ],
    });
    const { call } = await connect(registerGetActivityTool, api);

    const items = (await call("lnkdrp_get_activity", {})).items as ActivityItem[];
    expect(items[0]!.actor.key).toBeNull();
    expect(items[0]!.actor.url).toBeNull();
  });
});

describe("lnkdrp_revision_contributors", () => {
  it("carries a key and an absolute url on every member and agent row", async () => {
    const { api, calls } = apiWith({
      items: [],
      nextCursor: null,
      since: "2026-09-18T00:00:00.000Z",
      note: null,
      contributors: [{ userId: OWNER, name: "Christian Sanz", email: "c@example.com", replacements: 3, documents: 2, firstAt: "2026-09-18T00:00:00.000Z", lastAt: "2026-09-20T00:00:00.000Z" }],
      agents: [{ client: "claude-code", userId: OWNER, name: "Christian Sanz", ownerName: "Christian Sanz", replacements: 2, lastAt: "2026-09-20T00:00:00.000Z" }],
    });
    const { call } = await connect(registerRevisionContributorsTool, api);

    const out = await call("lnkdrp_revision_contributors", { since: "7d" });
    expect(calls[0]!.path).toBe("/api/changes");

    const contributors = out.contributors as Array<{ key: string | null; url: string | null; replacements: number }>;
    expect(contributors[0]).toMatchObject({ key: `user:${OWNER}`, url: `${BASE_URL}/people/${OWNER}`, replacements: 3 });

    const agents = out.agents as Array<{ key: string | null; url: string | null; ownerUserId: string | null; ownerName: { text: string } | null; name: { text: string } | null }>;
    expect(agents[0]).toMatchObject({ key: `agent:claude-code@${OWNER}`, url: `${BASE_URL}/agents/claude-code/${OWNER}`, ownerUserId: OWNER });
    // Both names come from the route and are wrapped as the member text they are; nothing here
    // invents a display name for either the client or the member.
    expect(agents[0]!.name?.text).toBe("Christian Sanz");
    expect(agents[0]!.ownerName?.text).toBe("Christian Sanz");
  });

  it("still links a client whose owner was never recorded", async () => {
    const { api } = apiWith({
      items: [],
      nextCursor: null,
      since: null,
      note: null,
      contributors: [],
      // No `ownerName`: an older deployment of the route, which sent the owner under `name` alone.
      agents: [{ client: "claude-code", userId: null, name: "Christian Sanz", replacements: 1, lastAt: "2026-09-20T00:00:00.000Z" }],
    });
    const { call } = await connect(registerRevisionContributorsTool, api);

    const agents = (await call("lnkdrp_revision_contributors", {})).agents as Array<{ key: string | null; url: string | null; ownerUserId: string | null; ownerName: { text: string } | null }>;
    // Its work happened; it simply has no person page to point at, so the key says so explicitly
    // rather than being dropped.
    expect(agents[0]).toMatchObject({ key: "agent:claude-code@unknown", url: `${BASE_URL}/agents/claude-code/unknown`, ownerUserId: null });
    // And the owner line is still filled from the one name that deployment sent.
    expect(agents[0]!.ownerName?.text).toBe("Christian Sanz");
  });
});
