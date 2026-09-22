/**
 * `lnkdrp_replace_pdf` must say so when the document it just updated is archived.
 *
 * The tool hands an agent a `/s/:shareId` URL, and that URL is the next thing the agent passes to a
 * human. On an archived document it resolves for nobody, yet the reply was
 * `{ status: "ready", version: N+1, shareUrl, warnings: [] }` with nothing naming the state: the
 * agent reports "updated, here is the link" and the recipients get "not found". Two tools on the
 * same surface, called a moment later on the same document, already answer this correctly
 * (`lnkdrp_create_share_link` and `lnkdrp_update_share_link` return `docArchived: true`), so the
 * two disagreed about the same document in adjacent calls.
 *
 * Archiving does not block the replace and should not: preparing a version before bringing a
 * document back is legitimate, and the upload route only guards deleted documents. The write was
 * right; only the report was incomplete. These tests hold the report.
 *
 * Harness style follows tests/lib/mcpReplacePdfUnchanged.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerReplacePdfTool } from "../../mcp/src/tools/replacePdf";
import type { ApiClient } from "../../mcp/src/api";

const DOC_ID = "6ab2227b44faa21e932ce70d";
const UPLOAD_ID = "6ab2228044faa21e932ce80f";
const SHARE_ID = "3y4ChKeffKMy";

/** Archive state the fake API reads on every getDoc, so a test can flip it mid-run. */
type DocState = { isArchived: boolean };

/** A fake REST client for a document whose archive state is whatever `state` currently says. */
function fakeApi(state: DocState) {
  return {
    getDoc: async () => ({
      id: DOC_ID,
      shareId: SHARE_ID,
      title: "Series A deck",
      status: "ready",
      currentUploadId: UPLOAD_ID,
      isArchived: state.isArchived,
    }),
    shareUrl: (shareId: string) => `http://localhost:3001/s/${shareId}`,
    createUpload: async () => ({ id: UPLOAD_ID, version: 2 }),
    importUrl: async () => undefined,
    processUpload: async () => undefined,
    patchDoc: async () => undefined,
    getUpload: async () => ({ id: UPLOAD_ID, status: "ready", error: null, unchangedFromPrevious: false, ai: null }),
    creditsSnapshot: async () => ({ creditsRemaining: 471 }),
  } as unknown as ApiClient;
}

/** Connect `lnkdrp_replace_pdf` to an in-memory client; one store, so a repeated key replays. */
async function connectReplace(api: ApiClient) {
  const server = new McpServer({ name: "test", version: "1" });
  registerReplacePdfTool(server, {
    api,
    config: { apiUrl: "http://localhost:3001", realtimeUrl: null, realtimeSecretConfigured: false },
    whoami: () => ({ orgId: "o1", orgName: "Personal", userId: "u1" }),
    idempotency: new IdempotencyStore(),
  } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "lnkdrp_replace_pdf", arguments: args });
    return res.structuredContent as Record<string, unknown>;
  };
}

const REPLACE = {
  docId: DOC_ID,
  sourceUrl: "https://example.com/series-a-deck-v2.pdf",
  timeoutSeconds: 5,
  summary: "The Series A deck with the updated financial model: traction, the raise, and the use of funds.",
  keyPoints: ["ARR at 1.4M", "Raising 8M", "20 months of runway"],
};

describe("replace_pdf on an archived document", () => {
  it("hands back the shareUrl with the archive state attached", async () => {
    const call = await connectReplace(fakeApi({ isArchived: true }));
    const out = await call({ ...REPLACE, idempotencyKey: "k-archived" });

    // The replace itself still happens, and still reports the new version: blocking it would be
    // wrong. What changes is that the reply no longer lets the agent call the link live.
    expect(out.status).toBe("ready");
    expect(out.version).toBe(2);
    expect(out.shareUrl).toBe(`http://localhost:3001/s/${SHARE_ID}`);

    expect(out.docArchived).toBe(true);
    expect(out.warnings).toEqual([expect.stringContaining("document is archived")]);
    // The remedy is one call, and the sentence has to name it or the agent has nothing to act on.
    expect(String((out.warnings as string[])[0])).toContain("lnkdrp_archive_doc");
  });

  it("says nothing extra about a live document", async () => {
    const call = await connectReplace(fakeApi({ isArchived: false }));
    const out = await call({ ...REPLACE, idempotencyKey: "k-live" });

    expect(out.status).toBe("ready");
    expect(out.docArchived).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });
});

describe("replace_pdf replays the archive state, not the cached one", () => {
  it("warns on a retry of a key whose document was archived in between", async () => {
    const state: DocState = { isArchived: false };
    const call = await connectReplace(fakeApi(state));

    const first = await call({ ...REPLACE, idempotencyKey: "k-archived-after" });
    expect(first.docArchived).toBeUndefined();

    // The human archived the document between the timeout and the retry. The cached result is the
    // one from before that, and a replay that repeats it reports a link that no longer opens.
    state.isArchived = true;
    const replay = await call({ ...REPLACE, idempotencyKey: "k-archived-after" });

    expect(replay.replayed).toBe(true);
    expect(replay.docArchived).toBe(true);
    expect(replay.warnings).toEqual([expect.stringContaining("document is archived")]);
  });

  it("drops the warning on a retry of a key whose document came back", async () => {
    const state: DocState = { isArchived: true };
    const call = await connectReplace(fakeApi(state));

    const first = await call({ ...REPLACE, idempotencyKey: "k-unarchived-after" });
    expect(first.docArchived).toBe(true);

    state.isArchived = false;
    const replay = await call({ ...REPLACE, idempotencyKey: "k-unarchived-after" });

    expect(replay.replayed).toBe(true);
    expect(replay.docArchived).toBeUndefined();
    expect(replay.warnings).toEqual([]);
  });
});
