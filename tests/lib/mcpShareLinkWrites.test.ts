/**
 * `lnkdrp_create_share_link` / `lnkdrp_update_share_link` — what the write tools say about a link
 * they just wrote.
 *
 * Both hand an agent a `/s/:shareId` URL it is about to pass to a human, so the two things they
 * report have to be true at the moment they are reported: whether that URL resolves, and whether
 * the label still tells this link apart from its siblings. Neither is knowable from the link row
 * alone, which is why both used to be answered wrongly.
 *
 * Harness style follows tests/lib/mcpRoundSixFixes.test.ts: register one tool against a fake
 * ApiClient over an in-memory transport and read `structuredContent`.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { registerCreateShareLinkTool, registerUpdateShareLinkTool } from "../../mcp/src/tools/shareLinks";

const DOC_ID = "6ab206c9d7e47b3f56a124d8";
const LINK_ID = "6ab2073cd7e47b3f56a13872";
const OTHER_LINK_ID = "6ab2073cd7e47b3f56a13873";

/** A link DTO as `src/lib/share/links.ts` builds it: status derived from the row, never the doc. */
function linkDto(over: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    docId: DOC_ID,
    shareId: "zfoZPSe7GInc",
    label: "Sequoia",
    audience: null,
    isDefault: false,
    enabled: true,
    allowDownload: false,
    allowRevisionHistory: false,
    passwordEnabled: false,
    expiresAt: null,
    active: true,
    status: "active",
    createdVia: "mcp",
    createdAt: null,
    lastViewedAt: null,
    viewCount: 0,
    downloadCount: 0,
    ...over,
  };
}

/** Connect one registrar to an in-memory client and return a caller for it. */
async function connect(register: (server: McpServer, ctx: ToolContext) => void, api: unknown) {
  const server = new McpServer({ name: "test", version: "1" });
  register(server, { api, config: {}, whoami: () => ({ orgId: "o1", orgName: "T" }) } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return res.structuredContent as Record<string, unknown>;
  };
}

/** The fake ApiClient both tools reach for. `links` is what the document already carries. */
function fakeApi(opts: { isArchived: boolean; links?: ReturnType<typeof linkDto>[] }) {
  const existing = opts.links ?? [];
  return {
    baseUrl: "http://localhost:3001",
    shareUrl: (shareId: string) => `http://localhost:3001/s/${shareId}`,
    getDoc: async () => ({ id: DOC_ID, isArchived: opts.isArchived }),
    listShareLinks: async () => existing,
    createShareLink: async (_docId: string, settings: Record<string, unknown>) => ({
      link: linkDto({ id: "6ab218979032651d9e4a54da", shareId: "sMzE2J8URoTB", label: settings.label }),
    }),
    updateShareLink: async (_docId: string, linkId: string, patch: Record<string, unknown>) => ({
      link: linkDto({ id: linkId, ...patch }),
      warnings: [],
    }),
  };
}

describe("create_share_link on an archived document", () => {
  it("does not call the new link active", async () => {
    // The link row keeps the enabled/expiry state unarchiving restores, so the DTO reads "active".
    // Returned raw, this tool handed the agent a shareUrl that 404s for every recipient while
    // list_share_links and get_share said, about the same link at the same moment, that it was
    // archived and not served at all.
    const call = await connect(registerCreateShareLinkTool, fakeApi({ isArchived: true }));
    const out = await call("lnkdrp_create_share_link", { docId: DOC_ID, label: "Archived probe" });
    const link = out.link as Record<string, unknown>;

    expect(link.status).toBe("archived");
    expect(link.active).toBe(false);
    expect(link.docArchived).toBe(true);
    expect(out.docArchived).toBe(true);
    expect(out.warnings).toEqual([expect.stringContaining("document is archived")]);
  });

  it("leaves a live document's link exactly as the API reported it", async () => {
    const call = await connect(registerCreateShareLinkTool, fakeApi({ isArchived: false }));
    const out = await call("lnkdrp_create_share_link", { docId: DOC_ID, label: "Accel" });
    const link = out.link as Record<string, unknown>;

    expect(link.status).toBe("active");
    expect(link.active).toBe(true);
    expect(link.docArchived).toBeUndefined();
    expect(out.docArchived).toBeUndefined();
    expect(out.warnings).toBeUndefined();
  });
});

describe("update_share_link on an archived document", () => {
  it("agrees with list_share_links about the link it just changed", async () => {
    const call = await connect(registerUpdateShareLinkTool, fakeApi({ isArchived: true }));
    const out = await call("lnkdrp_update_share_link", { docId: DOC_ID, linkId: LINK_ID, allowDownload: true });
    const link = out.link as Record<string, unknown>;

    expect(link.status).toBe("archived");
    expect(link.active).toBe(false);
    expect(out.warnings).toEqual([expect.stringContaining("document is archived")]);
  });
});

describe("update_share_link renaming onto an existing label", () => {
  it("warns the way create does, because it is the same end state by a quieter route", async () => {
    // Renaming produces no new row in the list to prompt a second look, so an owner left with two
    // links called "Sequoia" had never been told a thing.
    const api = fakeApi({
      isArchived: false,
      links: [
        linkDto({ id: OTHER_LINK_ID, shareId: "qTJr5f6wDvnW", label: "Sequoia" }),
        linkDto({ id: LINK_ID, shareId: "wtMDHOWOQmn7", label: "Accel" }),
      ],
    });
    const call = await connect(registerUpdateShareLinkTool, api);
    const out = await call("lnkdrp_update_share_link", { docId: DOC_ID, linkId: LINK_ID, label: "Sequoia" });

    expect(out.warnings).toEqual([expect.stringContaining('already has a link labelled "Sequoia"')]);
    expect(String((out.warnings as string[])[0])).toContain("qTJr5f6wDvnW");
  });

  it("does not warn a link about its own label", async () => {
    // Re-sending the same label with another setting is a no-op on the name; warning there would
    // teach an agent to ignore the warning.
    const api = fakeApi({
      isArchived: false,
      links: [linkDto({ id: LINK_ID, shareId: "wtMDHOWOQmn7", label: "Sequoia" })],
    });
    const call = await connect(registerUpdateShareLinkTool, api);
    const out = await call("lnkdrp_update_share_link", { docId: DOC_ID, linkId: LINK_ID, label: "Sequoia" });

    expect(out.warnings).toBeUndefined();
  });

  it("still passes through the warnings the route itself sends", async () => {
    const api = {
      ...fakeApi({ isArchived: false }),
      updateShareLink: async (_docId: string, linkId: string, patch: Record<string, unknown>) => ({
        link: linkDto({ id: linkId, ...patch }),
        warnings: ["Enabling this link re-shared the document and restored 2 links."],
      }),
    };
    const call = await connect(registerUpdateShareLinkTool, api);
    const out = await call("lnkdrp_update_share_link", { docId: DOC_ID, linkId: LINK_ID, enabled: true });

    expect(out.warnings).toEqual(["Enabling this link re-shared the document and restored 2 links."]);
  });
});
