/**
 * A repeated `lnkdrp_set_share_access` key must not describe access that is no longer there.
 *
 * The tool cached its whole answer under the idempotency key, and everything that builds that
 * answer - the patch, the password write, the re-read of the document and its links, and the
 * warning - sat inside the cached closure. So a second call with the same key handed back the view
 * captured at the first call, however far the document had moved since, with no `replayed` flag to
 * warn the caller it was reading a snapshot. Because this tool's entire payload is a description of
 * current access, the snapshot is usually inverted rather than merely stale: the agent tells its
 * human the link is password-protected when it is open to anyone, or that sharing is on for a
 * document that is archived or deleted and opens for nobody.
 *
 * Each test here states the false sentence it exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ApiDoc, ApiShareLink, DocPatch } from "../../mcp/src/api";
import type { ToolContext } from "../../mcp/src/context";
import { ToolError } from "../../mcp/src/errors";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerSetShareAccessTool } from "../../mcp/src/tools/setShareAccess";

const DOC_ID = "6ab2228c44faa21e932ce843";
const LINK_ID = "6ab2228c44faa21e932ce844";

function doc(over: Partial<ApiDoc> = {}): ApiDoc {
  return {
    id: DOC_ID,
    shareId: "GhtF3VqGZipa",
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
    ...over,
  };
}

function link(over: Partial<ApiShareLink> = {}): ApiShareLink {
  return {
    id: LINK_ID,
    docId: DOC_ID,
    shareId: "GhtF3VqGZipa",
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

type Result = Record<string, unknown>;

/**
 * A fake REST client whose document really changes, because that is the whole point: the defect
 * only shows once the state moves underneath a key that is then repeated.
 */
function connect() {
  const state = { doc: doc(), links: [link()], deleted: false, patches: 0, passwords: 0 };
  const gone = () => new ToolError("not_found", "That document does not exist (or is not in this workspace).", { status: 404 });

  const api = {
    patchDoc: async (_id: string, patch: DocPatch) => {
      if (state.deleted) throw gone();
      state.patches += 1;
      state.doc = { ...state.doc, ...patch };
      return state.doc;
    },
    setSharePassword: async (_id: string, password: string | null) => {
      if (state.deleted) throw gone();
      state.passwords += 1;
      state.doc = { ...state.doc, sharePasswordEnabled: password !== null };
      state.links = state.links.map((l) => (l.isDefault ? { ...l, passwordEnabled: password !== null } : l));
      return state.doc;
    },
    getDoc: async () => {
      if (state.deleted) throw gone();
      return state.doc;
    },
    listShareLinks: async () => {
      if (state.deleted) throw gone();
      return state.links;
    },
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
  const ready = Promise.all([server.connect(b), client.connect(a)]);

  const call = async (idempotencyKey: string, args: Record<string, unknown>) => {
    await ready;
    const res = (await client.callTool({
      name: "lnkdrp_set_share_access",
      arguments: { idempotencyKey, docId: DOC_ID, ...args },
    })) as CallToolResult;
    return { raw: res, out: (res.structuredContent ?? {}) as Result };
  };

  /** Archive the document the way lnkdrp_archive_doc would: links keep their own state. */
  const archive = () => {
    state.doc = { ...state.doc, isArchived: true };
    state.links = state.links.map((l) => ({ ...l, active: false, status: "archived" as const }));
  };

  return { call, state, archive };
}

/** The error envelope a failed tool call carries, as the client receives it. */
function errorCode(res: CallToolResult): string | null {
  const text = Array.isArray(res.content) && res.content[0]?.type === "text" ? res.content[0].text : "";
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

describe("set_share_access: a repeated key re-applies rather than replaying a snapshot", () => {
  it("does not report settings a later call turned off", async () => {
    const { call, state } = connect();

    const first = await call("k1", { allowDownload: true, password: "probe-pass" });
    expect(first.out.shareAllowPdfDownload).toBe(true);
    expect(first.out.sharePasswordEnabled).toBe(true);

    // A second key, a deliberate change: downloads off, password removed.
    const second = await call("k2", { allowDownload: false, password: null });
    expect(second.out.shareAllowPdfDownload).toBe(false);
    expect(second.out.sharePasswordEnabled).toBe(false);

    // The first key repeated verbatim. It used to answer {shareAllowPdfDownload: true,
    // sharePasswordEnabled: true} off the cache while the document said false to both, so the
    // agent told its human the link was password-protected when it opened for anyone. Now the
    // write runs again and the answer is the state it just produced, said to be a repeat.
    const replay = await call("k1", { allowDownload: true, password: "probe-pass" });
    expect(replay.out.replayed).toBe(true);
    expect(replay.out.shareAllowPdfDownload).toBe(true);
    expect(replay.out.sharePasswordEnabled).toBe(true);
    // Said because it is true: the document itself moved, it was not described from memory.
    expect(state.doc.shareAllowPdfDownload).toBe(true);
    expect(state.doc.sharePasswordEnabled).toBe(true);
    expect(state.patches).toBe(3);
    expect(state.passwords).toBe(3);
  });

  it("does not lose the archived warning when the document was archived in between", async () => {
    const { call, archive } = connect();

    const first = await call("k-arch", { shareEnabled: true });
    expect(first.out.isArchived).toBe(false);
    expect(first.out.warnings).toEqual([]);

    archive();

    // The cached answer said isArchived: false, anyLinkActive: true, warnings: [] - the exact
    // opposite of what a fresh key gets - so the repeat silently defeated the archived warning.
    const replay = await call("k-arch", { shareEnabled: true });
    expect(replay.out.replayed).toBe(true);
    expect(replay.out.isArchived).toBe(true);
    expect(replay.out.anyLinkActive).toBe(false);
    expect(replay.out.defaultLinkActive).toBe(false);
    const warnings = replay.out.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/archived/i);
  });

  it("does not hand back a live share URL for a document that was deleted in between", async () => {
    const { call, state } = connect();

    const first = await call("k-del", { shareEnabled: true, allowDownload: true });
    expect(first.raw.isError).toBeFalsy();
    expect(first.out.status).toBe("ready");

    state.deleted = true;

    // It used to answer status "ready", shareEnabled true and a share URL that resolves to
    // nothing. Re-running the write asks the API, and the API says the document is gone.
    const replay = await call("k-del", { shareEnabled: true, allowDownload: true });
    expect(replay.raw.isError).toBe(true);
    expect(errorCode(replay.raw)).toBe("not_found");
  });
});
