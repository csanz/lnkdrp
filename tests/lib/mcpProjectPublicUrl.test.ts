/**
 * A project tool must never hand back a `/p/` URL that answers "not found".
 *
 * `Project.shareEnabled` means "some link of this project is active" and `Project.shareId` points
 * at the default link whatever state that link is in: `syncProjectShareState`
 * (src/lib/share/projectLinks.ts) writes both and never consults the default link's own switch. So
 * disabling the default link of a project that has one other live link left every project read
 * saying `publicPageEnabled: true` beside `publicUrl: .../p/<the disabled link>`, which 404s. The
 * agent that disabled it was told nothing, and every agent after it believed the read.
 *
 * These tests hold `publicUrl` to "a URL that opens, or null": the project reads judge the link the
 * address actually belongs to, not the project's two summary fields.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ApiClient, ApiProject, ApiProjectLink } from "../../mcp/src/api";
import type { ToolContext } from "../../mcp/src/context";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerAddDocsToProjectTool, registerGetProjectTool, registerUpdateProjectTool } from "../../mcp/src/tools/projects";

const PROJECT_ID = "6ab6b044faa21e932cc8c800";
const DOC_ID = "6ab6b044faa21e932cc8c8d1";
/** The slug `Project.shareId` holds: the default link, the address earlier recipients were sent. */
const DEFAULT_SHARE = "LfX8olGVThDy";
/** A per-audience link created later. Its own URL keeps working whatever the default does. */
const SIBLING_SHARE = "NVwm18fiy7PN";

const PROJECT: ApiProject = {
  id: PROJECT_ID,
  shareId: DEFAULT_SHARE,
  name: "Series A data room",
  slug: "series-a-data-room",
  description: "",
  docCount: 1,
  autoAddFiles: false,
  // "Any link is active", which the sibling link keeps true on its own.
  shareEnabled: true,
  isRequest: false,
  createdDate: "2026-09-01T00:00:00.000Z",
  updatedDate: "2026-09-20T00:00:00.000Z",
};

function link(over: Partial<ApiProjectLink>): ApiProjectLink {
  return {
    id: "6ab6b044faa21e932cc8c9a1",
    projectId: PROJECT_ID,
    shareId: SIBLING_SHARE,
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
    createdAt: "2026-09-10T00:00:00.000Z",
    lastViewedAt: null,
    viewCount: 0,
    downloadCount: 0,
    ...over,
  };
}

const DEFAULT_DISABLED = link({
  id: "6ab6b044faa21e932cc8c9a0",
  shareId: DEFAULT_SHARE,
  label: "Default",
  isDefault: true,
  enabled: false,
  active: false,
  status: "disabled",
});
const DEFAULT_ACTIVE = link({ ...DEFAULT_DISABLED, enabled: true, active: true, status: "active" });

/**
 * A REST client for one project. `links` is what `GET /api/projects/:id/links` answers, or the
 * error it throws, which is the "we could not read them" case.
 */
function fakeApi(links: ApiProjectLink[] | Error, project: ApiProject = PROJECT) {
  return {
    projectPublicUrl: (shareId: string) => `http://localhost:3001/p/${shareId}`,
    projectAppUrl: (projectId: string) => `http://localhost:3001/projects/${projectId}`,
    shareUrl: (shareId: string) => `http://localhost:3001/s/${shareId}`,
    getProjectDocs: async () => ({ project, total: 1, page: 1, limit: 25, docs: [] }),
    listProjects: async () => ({ total: 1, page: 1, limit: 50, projects: [project] }),
    listProjectLinks: async () => {
      if (links instanceof Error) throw links;
      return links;
    },
    updateProject: async () => project,
    tagsForTarget: async () => [],
    tagsForTargets: async () => new Map(),
    listDocsPage: async () => ({ docs: [{ id: DOC_ID }], total: 1, page: 1, limit: 1 }),
    getDoc: async () => ({ id: DOC_ID, projectIds: [] as string[] }),
    patchDoc: async () => ({ doc: { id: DOC_ID, projectIds: [PROJECT_ID] } }),
  } as unknown as ApiClient;
}

/** Connect the project tools to an in-memory client and return a caller. */
async function connect(api: ApiClient) {
  const server = new McpServer({ name: "test", version: "1" });
  const ctx = {
    api,
    config: { apiUrl: "http://localhost:3001", realtimeUrl: null, realtimeSecretConfigured: false },
    whoami: () => ({ orgId: "o1", orgName: "Personal", userId: "u1" }),
    idempotency: new IdempotencyStore(),
  } as unknown as ToolContext;
  registerGetProjectTool(server, ctx);
  registerUpdateProjectTool(server, ctx);
  registerAddDocsToProjectTool(server, ctx);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return res.structuredContent as Record<string, unknown>;
  };
}

describe("a project read never publishes a dead /p/ URL", () => {
  it("nulls publicUrl when the link that address belongs to is disabled", async () => {
    const call = await connect(fakeApi([DEFAULT_DISABLED, link({})]));
    const out = await call("lnkdrp_get_project", { projectId: PROJECT_ID });
    const project = out.project as Record<string, unknown>;

    // The page really is on: the sibling link still serves it. The address is what died.
    expect(project.publicPageEnabled).toBe(true);
    expect(project.publicUrl).toBeNull();
    expect(String(project.publicUrlNote)).toContain(DEFAULT_SHARE);
    expect(String(project.publicUrlNote)).toContain("lnkdrp_list_project_links");
  });

  it("nulls it for an expired address too, not just a disabled one", async () => {
    const expired = { ...DEFAULT_DISABLED, enabled: true, active: false, status: "expired" as const };
    const call = await connect(fakeApi([expired, link({})]));
    const out = await call("lnkdrp_get_project", { projectId: PROJECT_ID });
    expect((out.project as Record<string, unknown>).publicUrl).toBeNull();
  });

  it("keeps the URL when the default link is live", async () => {
    const call = await connect(fakeApi([DEFAULT_ACTIVE, link({})]));
    const out = await call("lnkdrp_get_project", { projectId: PROJECT_ID });
    const project = out.project as Record<string, unknown>;
    expect(project.publicUrl).toBe(`http://localhost:3001/p/${DEFAULT_SHARE}`);
    expect(project.publicUrlNote).toBeUndefined();
  });

  it("keeps it when the links cannot be read, rather than failing the read", async () => {
    // Best-effort: a links listing that 500s is no reason to withhold the project, and no evidence
    // the address is dead. Answer as we always did.
    const call = await connect(fakeApi(new Error("links listing is down")));
    const out = await call("lnkdrp_get_project", { projectId: PROJECT_ID });
    expect((out.project as Record<string, unknown>).publicUrl).toBe(`http://localhost:3001/p/${DEFAULT_SHARE}`);
  });

  it("keeps it when the default link has no row yet", async () => {
    // A new project serves /p/<shareId> from a link materialised on first use. No row is not a
    // disabled link.
    const call = await connect(fakeApi([]));
    const out = await call("lnkdrp_get_project", { projectId: PROJECT_ID });
    expect((out.project as Record<string, unknown>).publicUrl).toBe(`http://localhost:3001/p/${DEFAULT_SHARE}`);
  });

  it("nulls it on the write tools' own echo of the project", async () => {
    const call = await connect(fakeApi([DEFAULT_DISABLED, link({})]));
    const out = await call("lnkdrp_update_project", { projectId: PROJECT_ID, name: "Series A data room" });
    expect((out.project as Record<string, unknown>).publicUrl).toBeNull();
  });

  it("does not tell add_docs_to_project's caller to send a dead address", async () => {
    const call = await connect(fakeApi([DEFAULT_DISABLED, link({})]));
    const out = await call("lnkdrp_add_docs_to_project", { projectId: PROJECT_ID, docIds: [DOC_ID] });
    expect(out.added).toEqual([DOC_ID]);
    expect(out.publicUrl).toBeUndefined();
    expect(String(out.publicPageNote)).toContain(DEFAULT_SHARE);
  });

  it("still hands over the address when it resolves", async () => {
    const call = await connect(fakeApi([DEFAULT_ACTIVE, link({})]));
    const out = await call("lnkdrp_add_docs_to_project", { projectId: PROJECT_ID, docIds: [DOC_ID] });
    expect(out.publicUrl).toBe(`http://localhost:3001/p/${DEFAULT_SHARE}`);
  });
});
