/**
 * `lnkdrp_replace_pdf` must say "unchangedFromPrevious" on the credit-free path too.
 *
 * The tool's description promises the flag unconditionally ("the new file reads the same as the one
 * it replaced ... Say so rather than reporting the document as updated") and, a few lines earlier,
 * tells the caller to pass summary + keyPoints so the replacement costs no credits. Those two
 * instructions used to contradict each other: the flag was read off `ai.summary === "unchanged"`,
 * which is the SUMMARY step's state, and the process route overwrites that with "done" whenever the
 * caller supplied the summary itself. So on the recommended path a byte-identical re-upload came
 * back as {status: "ready", version: N+1, warnings: []} and the agent told its human the document
 * had been updated, while the same run had recorded "No changes: this version reads the same as the
 * previous one".
 *
 * The upload row's own `unchangedFromPrevious` is set from the text compare and does not depend on
 * who wrote the summary. These tests hold the answer to that field instead.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { IdempotencyStore } from "../../mcp/src/idempotency";
import { registerReplacePdfTool } from "../../mcp/src/tools/replacePdf";
import { readAiOutcome } from "../../mcp/src/tools/aiWarnings";
import type { ApiClient, UploadAi } from "../../mcp/src/api";

const DOC_ID = "6ab21aac9032651d9e4a5e5a";
const UPLOAD_ID = "6ab21ab89032651d9e4a5f85";

/** The upload row as `GET /api/uploads/:id` hands it to the MCP client. */
type UploadRow = { unchangedFromPrevious: boolean; ai: UploadAi | null };

/** An agent-written summary: the process route records who wrote it and marks the step "done". */
const AGENT_SUMMARY_AI: UploadAi = {
  summary: "done",
  compare: "done",
  // The reason string the process route left behind before overwriting summary with "done" - the
  // fingerprint of the clobber this test exists for.
  reason: "the text is identical to the previous version, so its summary was kept",
  code: null,
  creditsNeeded: null,
  creditsUsed: 0,
  source: "owner",
  summaryBy: { kind: "agent", client: "hunter" },
};

/** lnkdrp wrote the summary itself and kept the previous version's text. */
const LNKDRP_UNCHANGED_AI: UploadAi = { ...AGENT_SUMMARY_AI, summary: "unchanged", summaryBy: null };

/** A fake REST client whose upload row is whatever the case under test says it is. */
function fakeApi(row: UploadRow) {
  return {
    getDoc: async () => ({ id: DOC_ID, shareId: "abc123", title: "Series A deck", status: "ready", currentUploadId: UPLOAD_ID }),
    shareUrl: (shareId: string) => `https://lnkdrp.com/s/${shareId}`,
    createUpload: async () => ({ id: UPLOAD_ID, version: 2 }),
    importUrl: async () => undefined,
    processUpload: async () => undefined,
    patchDoc: async () => undefined,
    getUpload: async () => ({ id: UPLOAD_ID, status: "ready", error: null, ...row }),
    creditsSnapshot: async () => ({ creditsRemaining: 536 }),
  } as unknown as ApiClient;
}

/** Connect `lnkdrp_replace_pdf` to an in-memory client and return a caller for it. */
async function connectReplace(api: ApiClient) {
  const server = new McpServer({ name: "test", version: "1" });
  registerReplacePdfTool(server, {
    api,
    config: { apiUrl: "https://lnkdrp.com", realtimeUrl: null, realtimeSecretConfigured: false },
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

const SAME_FILE = {
  docId: DOC_ID,
  sourceUrl: "https://example.com/series-a-deck.pdf",
  timeoutSeconds: 5,
};

const AGENT_TEXT = {
  summary: "The same Series A deck, re-sent unchanged: traction, the raise, and the use of funds, page for page.",
  keyPoints: ["ARR at 1.2M", "Raising 8M", "18 months of runway"],
};

describe("replace_pdf reports a no-op replacement", () => {
  it("says unchangedFromPrevious when the caller wrote the summary", async () => {
    // The recommended, credit-free path. Before the fix this returned no flag at all, because the
    // agent's own summary had overwritten ai.summary with "done".
    const call = await connectReplace(fakeApi({ unchangedFromPrevious: true, ai: AGENT_SUMMARY_AI }));
    const out = await call({ ...SAME_FILE, ...AGENT_TEXT, idempotencyKey: "k-agent" });

    expect(out.status).toBe("ready");
    expect(out.version).toBe(2);
    expect(out.unchangedFromPrevious).toBe(true);
    // Still not a warning: nothing was withheld, the previous summary simply still fits.
    expect(out.warnings).toEqual([]);
  });

  it("still says it when lnkdrp wrote the summary", async () => {
    const call = await connectReplace(fakeApi({ unchangedFromPrevious: true, ai: LNKDRP_UNCHANGED_AI }));
    const out = await call({ ...SAME_FILE, idempotencyKey: "k-lnkdrp" });
    expect(out.unchangedFromPrevious).toBe(true);
  });

  it("falls back to ai.summary when the row's flag never got written", async () => {
    // The process route writes that boolean best-effort and swallows its own failure, so a row can
    // say "unchanged" in ai and nothing in the flag. Reporting a real change there would be worse
    // than reporting a no-op.
    const call = await connectReplace(fakeApi({ unchangedFromPrevious: false, ai: LNKDRP_UNCHANGED_AI }));
    const out = await call({ ...SAME_FILE, idempotencyKey: "k-fallback" });
    expect(out.unchangedFromPrevious).toBe(true);
  });

  it("stays absent for a replacement that really changed the file", async () => {
    const changed: UploadAi = { ...AGENT_SUMMARY_AI, reason: null };
    const call = await connectReplace(fakeApi({ unchangedFromPrevious: false, ai: changed }));
    const out = await call({ ...SAME_FILE, ...AGENT_TEXT, idempotencyKey: "k-changed" });
    expect(out.unchangedFromPrevious).toBeUndefined();
  });
});

describe("readAiOutcome carries the upload's own verdict", () => {
  it("reads it from the row, not from the summary step", async () => {
    const outcome = await readAiOutcome(fakeApi({ unchangedFromPrevious: true, ai: AGENT_SUMMARY_AI }), UPLOAD_ID);
    expect(outcome.unchangedFromPrevious).toBe(true);
    expect(outcome.ai?.summary).toBe("done");
  });

  it("is false when there is no upload to read", async () => {
    const outcome = await readAiOutcome(fakeApi({ unchangedFromPrevious: true, ai: AGENT_SUMMARY_AI }), null);
    expect(outcome.unchangedFromPrevious).toBe(false);
  });
});
