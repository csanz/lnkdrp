/**
 * `lnkdrp_replace_pdf` must say so when another replacement took the document over while it ran.
 *
 * Two replacements can overlap on one document (two agents, or an agent while the owner clicks
 * "replace the file"). Both get a version number, both upload rows complete, and the server decides
 * which one the document lands on: `updateDocUnlessSuperseded` in the process route skips the doc
 * write when a newer upload is already current. The data was right. The reply was not: the tool
 * waited with `waitForDocStatus`, which resolves on the DOCUMENT's status, and then returned that
 * status beside its own version, its own uploadId and the shared shareUrl with `warnings: []`. The
 * losing call answered `{ status: "ready", version: 2, shareUrl, warnings: [] }` for a link already
 * serving version 3, which is the payload an agent turns into "updated, here's the link".
 *
 * Same failure shape as the one `docArchived` was added for, and the same remedy: the write stands,
 * the report gains the one fact that decides whether the shareUrl is worth sending.
 *
 * The second half of the same bug: because the wait could be satisfied by someone else's upload
 * finishing, `readAiOutcome` could read this call's row before it was written, so
 * `unchangedFromPrevious`, `failureReason` and the credit figure came off a half-finished row.
 *
 * Harness style follows tests/lib/mcpReplacePdfArchived.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerReplacePdfTool } from "../../mcp/src/tools/replacePdf";
import type { ApiClient } from "../../mcp/src/api";

const DOC_ID = "6ab2302c44faa21e932d1284";
const PREVIOUS_UPLOAD = "6ab2301044faa21e932d1101";
/** The upload this call creates. */
const OURS = "6ab2303844faa21e932d136a";
/** The upload the other session creates a millisecond later, which the document ends up on. */
const RIVAL = "6ab2303844faa21e932d1368";
const SHARE_ID = "8GcVK4zsKJZa";

/** What the document currently points at, so a test can move it mid-run the way a race does. */
type DocState = { currentUploadId: string; version: number };

type UploadRow = { status: string; unchangedFromPrevious?: boolean; error?: string | null };

/**
 * A fake REST client for one document.
 *
 * `onProcess` is where the race is staged: `POST /api/uploads/:id/process` is the last thing this
 * call does before it starts waiting, so moving the document there reproduces exactly the window in
 * which the rival's file wins. `uploadRows` is a queue per upload id so a row can be read as still
 * processing once and completed afterwards.
 */
function fakeApi(state: DocState, uploadRows: Record<string, UploadRow[]>, onProcess?: () => void) {
  const reads: string[] = [];
  const api = {
    getDoc: async () => ({
      id: DOC_ID,
      shareId: SHARE_ID,
      title: "Series A deck",
      status: "ready",
      currentUploadId: state.currentUploadId,
      version: state.version,
      isArchived: false,
    }),
    shareUrl: (shareId: string) => `http://localhost:3001/s/${shareId}`,
    createUpload: async () => ({ id: OURS, version: 2 }),
    importUrl: async () => undefined,
    processUpload: async () => {
      onProcess?.();
    },
    patchDoc: async () => undefined,
    getUpload: async (uploadId: string) => {
      reads.push(uploadId);
      const queue = uploadRows[uploadId] ?? [{ status: "completed" }];
      const row = queue.length > 1 ? (queue.shift() as UploadRow) : queue[0];
      return { id: uploadId, status: row.status, error: row.error ?? null, unchangedFromPrevious: row.unchangedFromPrevious === true, ai: null };
    },
    creditsSnapshot: async () => ({ creditsRemaining: 471 }),
  };
  return { api: api as unknown as ApiClient, reads };
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
  sourceUrl: "https://example.com/board-deck-q2.pdf",
  timeoutSeconds: 5,
  summary: "The board deck for Q2 with the updated financial model: traction, the raise, and the use of funds.",
  keyPoints: ["ARR at 1.4M", "Raising 8M", "20 months of runway"],
};

describe("replace_pdf when another replacement wins the race", () => {
  it("names the version the shareUrl actually serves", async () => {
    const state: DocState = { currentUploadId: PREVIOUS_UPLOAD, version: 1 };
    // The other session's upload lands while this one is being processed.
    const { api } = fakeApi(state, { [OURS]: [{ status: "completed" }] }, () => {
      state.currentUploadId = RIVAL;
      state.version = 3;
    });
    const call = await connectReplace(api);
    const out = await call({ ...REPLACE, idempotencyKey: "k-superseded" });

    // The replace itself stands: version 2 was allocated, stored and kept in the history. Nothing
    // here blocks or retries it. What changes is that the reply no longer lets the agent call this
    // version the one behind the link.
    expect(out.version).toBe(2);
    expect(out.uploadId).toBe(OURS);
    expect(out.shareUrl).toBe(`http://localhost:3001/s/${SHARE_ID}`);

    expect(out.supersededBy).toEqual({ uploadId: RIVAL, version: 3 });
    expect(out.warnings).toEqual([expect.stringContaining("Another replacement has taken this document over")]);
    // Both numbers, or the agent cannot tell its human which file recipients see.
    const warning = String((out.warnings as string[])[0]);
    expect(warning).toContain("version 3");
    expect(warning).toContain("version 2");
  });

  it("says nothing extra when this call's own upload is the one the document is on", async () => {
    const state: DocState = { currentUploadId: PREVIOUS_UPLOAD, version: 1 };
    const { api } = fakeApi(state, { [OURS]: [{ status: "completed" }] }, () => {
      state.currentUploadId = OURS;
      state.version = 2;
    });
    const call = await connectReplace(api);
    const out = await call({ ...REPLACE, idempotencyKey: "k-clean" });

    expect(out.status).toBe("ready");
    expect(out.version).toBe(2);
    expect(out.supersededBy).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it("reports this call's own upload status, not the one the rival caused", async () => {
    const state: DocState = { currentUploadId: PREVIOUS_UPLOAD, version: 1 };
    // The document is `ready` because the rival finished. This call's own row is still processing,
    // and the row it eventually writes says the file read the same as the previous version.
    const { api, reads } = fakeApi(
      state,
      { [OURS]: [{ status: "processing" }, { status: "completed", unchangedFromPrevious: true }] },
      () => {
        state.currentUploadId = RIVAL;
        state.version = 3;
      },
    );
    const call = await connectReplace(api);
    const out = await call({ ...REPLACE, idempotencyKey: "k-half-written" });

    expect(out.supersededBy).toEqual({ uploadId: RIVAL, version: 3 });
    expect(out.status).toBe("ready");
    expect(out.timedOut).toBeUndefined();
    // The point of waiting for this call's own row: read at the document's terminal moment it still
    // said "processing", and every fact below is derived from it.
    expect(out.unchangedFromPrevious).toBe(true);
    expect(out.creditsRemaining).toBe(471);
    expect(reads.filter((id) => id === OURS).length).toBeGreaterThan(1);
  });
});

describe("replace_pdf replays the supersede state, not the cached one", () => {
  it("warns on a retry of a key whose document moved on in between", async () => {
    const state: DocState = { currentUploadId: PREVIOUS_UPLOAD, version: 1 };
    const { api } = fakeApi(state, { [OURS]: [{ status: "completed" }] }, () => {
      state.currentUploadId = OURS;
      state.version = 2;
    });
    const call = await connectReplace(api);

    const first = await call({ ...REPLACE, idempotencyKey: "k-superseded-after" });
    expect(first.supersededBy).toBeUndefined();

    // Somebody replaced the file again between the two calls. The cached result is from before
    // that, and a replay that repeats it reports a version the link no longer serves.
    state.currentUploadId = RIVAL;
    state.version = 3;
    const replay = await call({ ...REPLACE, idempotencyKey: "k-superseded-after" });

    expect(replay.replayed).toBe(true);
    expect(replay.supersededBy).toEqual({ uploadId: RIVAL, version: 3 });
    expect(replay.warnings).toEqual([expect.stringContaining("Another replacement has taken this document over")]);
  });
});
