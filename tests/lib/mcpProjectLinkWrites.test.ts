/**
 * `lnkdrp_list_project_links` / `lnkdrp_update_project_link` — what the project-link tools say
 * about a data room an agent is about to describe to a human.
 *
 * Two answers here used to be taken on trust from a denormalised field or not given at all:
 * whether `/p/:shareId` resolves for anyone (`Project.shareEnabled` is only recomputed when a link
 * is written, and expiry is not a write), and whether a rename has just produced two links with
 * one name. The document side learned both lessons first; these are the project mirrors.
 *
 * Harness style follows tests/lib/mcpShareLinkWrites.test.ts: register one tool against a fake
 * ApiClient over an in-memory transport and read `structuredContent`.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { registerListProjectLinksTool, registerUpdateProjectLinkTool } from "../../mcp/src/tools/projectLinks";

const PROJECT_ID = "6ab222ed44faa21e932cf086";
const LINK_ID = "6ab20761d7e47b3f56a13dc0";
const OTHER_LINK_ID = "6ab2075ed7e47b3f56a13d37";

/** A project link DTO as `toProjectLinkDTO` builds it: `active` derived live, expiry included. */
function linkDto(over: Record<string, unknown> = {}) {
  const base = {
    id: LINK_ID,
    projectId: PROJECT_ID,
    shareId: "CmjmiJYDVzg8",
    label: "Sequoia",
    audience: null,
    isDefault: false,
    enabled: true,
    allowDownload: false,
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
  // The route never sends `status: "expired"` with `active: true`; keep the fake honest about that.
  return { ...base, active: base.status === "active" };
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

/** The fake ApiClient both tools reach for. `shareEnabled` is the project's stored flag. */
function fakeApi(opts: { shareEnabled: boolean | null; links?: ReturnType<typeof linkDto>[] }) {
  const existing = opts.links ?? [];
  return {
    baseUrl: "http://localhost:3001",
    projectPublicUrl: (shareId: string) => `http://localhost:3001/p/${shareId}`,
    projectAppUrl: (id: string) => `http://localhost:3001/projects/${id}`,
    getProjectDocs: async () => ({
      project: { id: PROJECT_ID, slug: "customer-diligence", name: "Customer Diligence", shareEnabled: opts.shareEnabled, shareId: "CmjmiJYDVzg8", isRequest: false },
      total: 3,
      docs: [],
    }),
    listProjectLinks: async () => existing,
    updateProjectLink: async (_projectId: string, linkId: string, patch: Record<string, unknown>) => ({
      link: linkDto({ id: linkId, ...patch }),
      warnings: [] as string[],
    }),
  };
}

describe("list_project_links when every link has expired", () => {
  it("does not answer publicPageEnabled: true about a page that 404s for everyone", async () => {
    // `Project.shareEnabled` is written only by syncProjectShareState, which runs on link writes.
    // Expiry is the passage of time, so the stored flag stays on forever while /p/:shareId serves
    // nobody, and an agent asked "is the data room still reachable?" said yes.
    const call = await connect(
      registerListProjectLinksTool,
      fakeApi({
        shareEnabled: true,
        links: [
          linkDto({ id: LINK_ID, shareId: "CmjmiJYDVzg8", label: "Default link", isDefault: true, status: "disabled", enabled: false }),
          linkDto({ id: OTHER_LINK_ID, shareId: "FWG98p4axl4i", label: "Alpha", status: "expired", expiresAt: "2026-09-20T00:00:00.000Z" }),
        ],
      }),
    );
    const out = await call("lnkdrp_list_project_links", { projectId: PROJECT_ID });

    expect(out.publicPageEnabled).toBe(false);
    expect(out.warnings).toEqual([expect.stringContaining("does not resolve for anyone")]);
    const warning = String((out.warnings as string[])[0]);
    expect(warning).toContain("1 expired");
    // The switch cannot undo time, and an agent told to "turn it back on" would have looped.
    expect(warning).toContain("lnkdrp_update_project_link");
  });

  it("stays true while one link is still live", async () => {
    const call = await connect(
      registerListProjectLinksTool,
      fakeApi({
        shareEnabled: true,
        links: [linkDto({ status: "expired" }), linkDto({ id: OTHER_LINK_ID, shareId: "FWG98p4axl4i", label: "Accel" })],
      }),
    );
    const out = await call("lnkdrp_list_project_links", { projectId: PROJECT_ID });

    expect(out.publicPageEnabled).toBe(true);
    expect(out.warnings).toBeUndefined();
  });

  it("keeps the stored flag for a query, which only ever sees a subset", async () => {
    // A search that matches one expired link says nothing about the links it filtered out.
    const call = await connect(registerListProjectLinksTool, fakeApi({ shareEnabled: true, links: [linkDto({ status: "expired" })] }));
    const out = await call("lnkdrp_list_project_links", { projectId: PROJECT_ID, query: "sequoia" });

    expect(out.publicPageEnabled).toBe(true);
    expect(out.warnings).toBeUndefined();
  });

  it("keeps the stored flag when the default link has no row yet", async () => {
    // A brand-new project serves /p/:shareId with an empty listing; deriving false there would
    // answer "private" about a page anyone holding the URL can read.
    const call = await connect(registerListProjectLinksTool, fakeApi({ shareEnabled: true, links: [] }));
    const out = await call("lnkdrp_list_project_links", { projectId: PROJECT_ID });

    expect(out.publicPageEnabled).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(String(out.note)).toContain("default link has no row yet");
  });

  it("says so when the stored flag reads off and the rows are serving", async () => {
    const call = await connect(registerListProjectLinksTool, fakeApi({ shareEnabled: false, links: [linkDto()] }));
    const out = await call("lnkdrp_list_project_links", { projectId: PROJECT_ID });

    expect(out.publicPageEnabled).toBe(true);
    expect(out.warnings).toEqual([expect.stringContaining("stored public-page switch reads off")]);
  });
});

describe("update_project_link renaming onto an existing label", () => {
  it("warns the way create does, because it is the same end state by a quieter route", async () => {
    // Two links called "Sequoia" on one data room are indistinguishable in every listing and in
    // query; a rename adds no new row to prompt the second look a create does.
    const api = fakeApi({
      shareEnabled: true,
      links: [
        linkDto({ id: OTHER_LINK_ID, shareId: "qTJr5f6wDvnW", label: "Sequoia" }),
        linkDto({ id: LINK_ID, shareId: "CmjmiJYDVzg8", label: "Index" }),
      ],
    });
    const call = await connect(registerUpdateProjectLinkTool, api);
    const out = await call("lnkdrp_update_project_link", { projectId: PROJECT_ID, linkId: LINK_ID, label: "Sequoia" });

    expect(out.warnings).toEqual([expect.stringContaining('already has a link labelled "Sequoia"')]);
    expect(String((out.warnings as string[])[0])).toContain("qTJr5f6wDvnW");
  });

  it("does not warn a link about its own label", async () => {
    const api = fakeApi({ shareEnabled: true, links: [linkDto({ id: LINK_ID, shareId: "CmjmiJYDVzg8", label: "Sequoia" })] });
    const call = await connect(registerUpdateProjectLinkTool, api);
    const out = await call("lnkdrp_update_project_link", { projectId: PROJECT_ID, linkId: LINK_ID, label: "Sequoia" });

    expect(out.warnings).toBeUndefined();
  });

  it("does not read the link list when no rename was asked for", async () => {
    let listed = 0;
    const api = { ...fakeApi({ shareEnabled: true, links: [linkDto()] }), listProjectLinks: async () => (listed++, [linkDto()]) };
    const call = await connect(registerUpdateProjectLinkTool, api);
    const out = await call("lnkdrp_update_project_link", { projectId: PROJECT_ID, linkId: LINK_ID, allowDownload: true });

    expect(listed).toBe(0);
    expect(out.warnings).toBeUndefined();
  });

  it("still passes through the warnings the route itself sends", async () => {
    const api = {
      ...fakeApi({ shareEnabled: true, links: [linkDto({ id: OTHER_LINK_ID, shareId: "qTJr5f6wDvnW", label: "Sequoia" })] }),
      updateProjectLink: async (_projectId: string, linkId: string, patch: Record<string, unknown>) => ({
        link: linkDto({ id: linkId, ...patch }),
        warnings: ["Enabling this link republished the project's public page and restored 2 links."],
      }),
    };
    const call = await connect(registerUpdateProjectLinkTool, api);
    const out = await call("lnkdrp_update_project_link", { projectId: PROJECT_ID, linkId: LINK_ID, label: "Sequoia", enabled: true });

    expect(out.warnings).toEqual([expect.stringContaining('already has a link labelled "Sequoia"'), expect.stringContaining("republished")]);
  });
});
