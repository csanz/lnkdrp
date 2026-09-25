/**
 * `lnkdrp_set_share_access` must not invent a reason a link is shut.
 *
 * The warning it returns is the only thing an agent has to explain "I turned sharing on and the
 * document still opens for nobody", and it used to read that explanation off two booleans that do
 * not carry one: shared.ts computes anyLinkActive/defaultLinkActive as
 * `!doc.isArchived && link.enabled && link.active`, so archiving and expiry both arrive as the same
 * false. The tool then blamed revocation in every case and prescribed lnkdrp_update_share_link
 * { enabled: true }, which on an already-enabled link changes nothing and reports success. Each
 * test here states the false sentence it exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ApiDoc, ApiShareLink } from "../../mcp/src/api";
import type { ToolContext } from "../../mcp/src/context";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerSetShareAccessTool } from "../../mcp/src/tools/setShareAccess";

const DOC_ID = "6ab20713d7e47b3f56a130cb";
const LINK_ID = "6ab20713d7e47b3f56a130cc";

function doc(over: Partial<ApiDoc> = {}): ApiDoc {
  return {
    id: DOC_ID,
    shareId: "i6K7KHqnb4M8",
    title: "Northwind Series A deck",
    status: "ready",
    isArchived: false,
    currentUploadId: "u1",
    previewImageUrl: null,
    oneLiner: null,
    summary: null,
    shareEnabled: true,
    shareAllowPdfDownload: false,
    shareAllowRevisionHistory: false,
    sharePasswordEnabled: false,
    projectIds: [],
    version: 1,
    pageCount: 12,
    keyPoints: [],
    primaryProjectId: null,
    visibility: "workspace",
    ...over,
  };
}

function link(over: Partial<ApiShareLink> = {}): ApiShareLink {
  return {
    id: LINK_ID,
    docId: DOC_ID,
    shareId: "i6K7KHqnb4M8",
    label: "Default link",
    audience: null,
    isDefault: true,
    enabled: true,
    allowDownload: false,
    allowRevisionHistory: false,
    passwordEnabled: false,
    expiresAt: null,
    active: true,
    status: "active",
    createdVia: "web",
    createdAt: null,
    lastViewedAt: null,
    viewCount: 0,
    downloadCount: 0,
    ...over,
  };
}

/** Connect the tool to an in-memory client over a fake API that serves one doc and its links. */
async function connect(current: ApiDoc, links: ApiShareLink[]) {
  const api = {
    patchDoc: async () => current,
    setSharePassword: async () => current,
    getDoc: async () => current,
    listShareLinks: async () => links,
    shareUrl: (shareId: string) => `https://lnkdrp.com/s/${shareId}`,
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerSetShareAccessTool(server, {
    api,
    config: {},
    idempotency: new IdempotencyStore(),
    whoami: () => ({ orgId: "o1", orgName: "Personal" }),
  } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let n = 0;
  return async (args: Record<string, unknown>) => {
    const res = await client.callTool({
      name: "lnkdrp_set_share_access",
      arguments: { idempotencyKey: `k-${++n}`, docId: DOC_ID, ...args },
    });
    return res.structuredContent as { warnings: string[]; isArchived: boolean; anyLinkActive: boolean; defaultLinkActive: boolean };
  };
}

describe("set_share_access warnings name the real cause", () => {
  it("blames archiving, not revocation, on an archived document", async () => {
    // The link is enabled: nothing was revoked. It opens for nobody because the document is
    // archived, and the old warning said "every link on this document had been revoked on its own
    // ... enable a specific link with lnkdrp_update_share_link" next to its own isArchived: true.
    // That remedy is a no-op that reports success.
    const call = await connect(doc({ isArchived: true }), [link({ enabled: true, active: false, status: "archived" })]);
    const out = await call({ shareEnabled: true });

    expect(out.isArchived).toBe(true);
    expect(out.warnings).toHaveLength(1);
    const [w] = out.warnings;
    expect(w).toMatch(/archived/i);
    expect(w).toMatch(/lnkdrp_archive_doc archived: false/);
    expect(w).not.toMatch(/revoked/i);
  });

  it("blames the expiry, not a disabling, when the default link has expired", async () => {
    // Other links are live, so this lands in the default-link branch. The link is enabled and its
    // status is "expired" in the very same payload, but the warning said it "was turned off on its
    // own" and told the agent to turn it on, which does nothing to an expiry.
    const expiresAt = "2026-09-22T05:47:55.000Z";
    const call = await connect(
      doc(),
      [link({ enabled: true, active: false, status: "expired", expiresAt }), link({ id: "x", shareId: "other", label: "Investor", isDefault: false })],
    );
    const out = await call({ shareEnabled: true });

    expect(out.anyLinkActive).toBe(true);
    expect(out.defaultLinkActive).toBe(false);
    expect(out.warnings).toHaveLength(1);
    const [w] = out.warnings;
    expect(w).toMatch(/expiry has passed/);
    expect(w).toContain(expiresAt);
    expect(w).toMatch(/expiresAt: null/);
    expect(w).not.toMatch(/turned off on its own/);
  });

  it("says every link expired when that is what happened", async () => {
    const call = await connect(doc(), [
      link({ enabled: true, active: false, status: "expired", expiresAt: "2026-09-20T00:00:00.000Z" }),
      link({ id: "x", shareId: "other", label: "Investor", isDefault: false, enabled: true, active: false, status: "expired", expiresAt: "2026-09-19T00:00:00.000Z" }),
    ]);
    const out = await call({ shareEnabled: true });

    expect(out.anyLinkActive).toBe(false);
    expect(out.warnings[0]).toMatch(/passed its expiry date/);
    expect(out.warnings[0]).not.toMatch(/revoked/i);
  });

  it("still blames revocation when every link really was revoked", async () => {
    // The case the ladder was originally written for has to keep its wording and its remedy.
    const call = await connect(doc(), [link({ enabled: false, active: false, status: "disabled" })]);
    const out = await call({ shareEnabled: true });

    expect(out.anyLinkActive).toBe(false);
    expect(out.warnings[0]).toMatch(/revoked on its own/);
    expect(out.warnings[0]).toMatch(/lnkdrp_update_share_link/);
  });

  it("still blames the disabling when only the default link was turned off", async () => {
    const call = await connect(doc(), [
      link({ enabled: false, active: false, status: "disabled" }),
      link({ id: "x", shareId: "other", label: "Investor", isDefault: false }),
    ]);
    const out = await call({ shareEnabled: true });

    expect(out.defaultLinkActive).toBe(false);
    expect(out.warnings[0]).toMatch(/turned off on its own/);
  });

  it("warns about nothing when the switch opened the document", async () => {
    const call = await connect(doc(), [link()]);
    expect((await call({ shareEnabled: true })).warnings).toEqual([]);
    // And a call that never asked for sharing says nothing either way.
    expect((await connect(doc({ isArchived: true }), [link({ active: false, status: "archived" })]).then((c) => c({ allowDownload: true }))).warnings).toEqual([]);
  });
});
