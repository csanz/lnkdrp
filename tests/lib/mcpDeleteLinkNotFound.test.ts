/**
 * `lnkdrp_delete_share_link` / `lnkdrp_delete_project_link` — what a stale linkId is told.
 *
 * Both deletes resolve the link client-side, out of the list they already read to build the
 * confirmation preview, so the REST route never 404s and `mapApiError` never runs. That is how the
 * two of them came to write their own, shorter refusal ("No share link with that id on this
 * document.") while every other tool reaching the same fault on the same object got the mapper's
 * sentence, which names how the agent probably got here and which call finds the right id. One
 * fault, two messages, and the terser one was on the tool where the next guess deletes something.
 *
 * The assertions compare the two deletes against `mapApiError` itself rather than against a
 * hard-coded sentence, because the defect was drift between the two, not the wording of either.
 *
 * Harness style follows tests/lib/mcpShareLinkWrites.test.ts: register one tool against a fake
 * ApiClient over an in-memory transport.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { mapApiError } from "../../mcp/src/errors";
import { registerDeleteShareLinkTool } from "../../mcp/src/tools/shareLinks";
import { registerDeleteProjectLinkTool } from "../../mcp/src/tools/projectLinks";

const DOC_ID = "6ab20688d7e47b3f56a11aa7";
const PROJECT_ID = "6ab20722d7e47b3f56a13355";
const REAL_LINK_ID = "6ab2073cd7e47b3f56a13872";
/** The shape an agent actually holds: a well-formed id that is not on this object any more. */
const STALE_LINK_ID = "000000000000000000000000";

/** The sentence the mapper gives for the same fault arriving as a 404 from the API. */
function mapped(path: string, error: string): string {
  return mapApiError({ status: 404, body: { error }, method: "DELETE", path, siteUrl: "http://localhost:3001" }).message;
}

const linkDto = (over: Record<string, unknown> = {}) => ({
  id: REAL_LINK_ID,
  shareId: "zfoZPSe7GInc",
  label: "Sequoia",
  audience: null,
  isDefault: false,
  enabled: true,
  allowDownload: false,
  passwordEnabled: false,
  expiresAt: null,
  active: true,
  status: "active",
  lastViewedAt: null,
  viewCount: 0,
  downloadCount: 0,
  ...over,
});

/** Connect one registrar to an in-memory client and return the parsed error envelope of a call. */
async function callForError(register: (server: McpServer, ctx: ToolContext) => void, api: unknown, name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: "test", version: "1" });
  register(server, { api, config: {}, whoami: () => ({ orgId: "o1", orgName: "T" }) } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as { type: string; text: string }[])[0].text;
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

describe("delete_share_link with a linkId the document does not have", () => {
  it("answers with the same sentence every other tool gives for that fault", async () => {
    const api = {
      shareUrl: (shareId: string) => `http://localhost:3001/s/${shareId}`,
      listShareLinks: async () => [linkDto()],
      getDoc: async () => ({ id: DOC_ID, title: "Series A deck", isArchived: false }),
      deleteShareLink: async () => {
        throw new Error("must not delete anything");
      },
    };
    const err = await callForError(registerDeleteShareLinkTool, api, "lnkdrp_delete_share_link", { docId: DOC_ID, linkId: STALE_LINK_ID });
    expect(err.code).toBe("not_found");
    // The mapper's own words, not a second wording of them.
    expect(err.message).toBe(mapped(`/api/docs/${DOC_ID}/links/${STALE_LINK_ID}`, "Link not found."));
    // The two things the old message left out: how you got here, and what to call next.
    expect(err.message).toContain("may belong to a different document");
    expect(err.message).toContain("lnkdrp_find_share_link");
  });
});

describe("delete_project_link with a linkId the project does not have", () => {
  it("answers with the same sentence every other tool gives for that fault", async () => {
    const api = {
      projectPublicUrl: (shareId: string) => `http://localhost:3001/p/${shareId}`,
      getProjectDocs: async () => ({ project: { id: PROJECT_ID, name: "Northwind", slug: "northwind", isRequest: false }, total: 6, docs: [] }),
      listProjectLinks: async () => [linkDto()],
      deleteProjectLink: async () => {
        throw new Error("must not delete anything");
      },
    };
    const err = await callForError(registerDeleteProjectLinkTool, api, "lnkdrp_delete_project_link", { projectId: PROJECT_ID, linkId: STALE_LINK_ID });
    expect(err.code).toBe("not_found");
    expect(err.message).toBe(mapped(`/api/projects/${PROJECT_ID}/links/${STALE_LINK_ID}`, "Link not found."));
    // A document link's id passed to the project tool is the likeliest way to hold a wrong one
    // here, and it is the hypothesis the terse message never named.
    expect(err.message).toContain("be a document link rather than a project link");
    expect(err.message).toContain("lnkdrp_list_project_links");
  });

  it("still names the project, not the link, when the projectId is the wrong one", async () => {
    // The other half of the pair this defect was found by: one handler, two ids. The projectId has
    // always had a next step, which is why the linkId reading "No project link with that id" next
    // to it was an oversight rather than a deliberately quiet destructive path.
    const api = {
      projectPublicUrl: (shareId: string) => `http://localhost:3001/p/${shareId}`,
      getProjectDocs: async () => ({ project: { id: PROJECT_ID, name: "Intake", slug: "intake", isRequest: true }, total: 0, docs: [] }),
      listProjectLinks: async () => [linkDto()],
    };
    const err = await callForError(registerDeleteProjectLinkTool, api, "lnkdrp_delete_project_link", { projectId: PROJECT_ID, linkId: REAL_LINK_ID });
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("lnkdrp_list_projects");
  });
});
