/**
 * `lnkdrp_get_share_stats` must not describe a dark document in the present tense.
 *
 * Two defects, one tool. Archive state lives on the document and the shareviews route reads link
 * rows only, so archiving changed nothing in this response: it came back identical to the live one,
 * downloadsEnabled and all, and the agent reported open counts and "downloads are enabled" about a
 * document whose links resolve for nobody. And the per-link 404 told a caller who had passed
 * docId + shareId to pass the docId - advice they had already followed - while never naming the one
 * thing that had actually happened: the link was deleted.
 *
 * Each test states the false sentence it exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../../mcp/src/context";
import { ToolError } from "../../mcp/src/errors";
import { registerGetShareStatsTool } from "../../mcp/src/tools/getShareStats";

const DOC_ID = "6ab2069ad7e47b3f56a11d92";
const SHARE_ID = "WD3f1mI31hin";

/** The seeded Cap Table's own numbers: real traffic, so the counts have to survive the fix. */
const STATS = {
  days: 60,
  analyticsDaysLimit: null,
  analyticsTier: "deep",
  viewerCount: 3,
  totals: {
    views: 3,
    ownerPreviews: 1,
    opens: 6,
    opensPartial: false,
    downloads: 2,
    pagesViewed: 14,
    timeSpentMs: 90_000,
    authenticatedViewers: 0,
    anonymousViewers: 3,
  },
  series: [],
  viewers: [],
  anonymousViewers: [],
  projectLinkTraffic: null,
  totalsAllTime: { views: 9, opens: 21, downloads: 4 },
  lastViewedAt: "2026-09-22T05:15:58.632Z",
  downloadsEnabled: true,
};

async function connect(api: unknown) {
  const server = new McpServer({ name: "test", version: "1" });
  registerGetShareStatsTool(server, { api, config: {}, whoami: () => ({ orgId: "o1", orgName: "Personal" }) } as unknown as ToolContext);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (args: Record<string, unknown>) => client.callTool({ name: "lnkdrp_get_share_stats", arguments: args });
}

/** The tool's own structured payload. */
async function stats(api: unknown, args: Record<string, unknown>) {
  const call = await connect(api);
  const res = await call(args);
  return res.structuredContent as Record<string, unknown>;
}

/** The message text of an error envelope. */
async function failure(api: unknown, args: Record<string, unknown>) {
  const call = await connect(api);
  const res = await call(args);
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ text: string }>)[0].text;
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

describe("get_share_stats on an archived document", () => {
  it("flags the archive instead of reading as a live document", async () => {
    // Before: byte-identical to the pre-archive response. The agent said "3 investors have opened
    // it, 6 sessions, downloads are enabled" about a document that has been dark since it was
    // archived, with nothing in the payload to prompt a second look.
    const out = await stats(
      { getDoc: async () => ({ id: DOC_ID, shareId: SHARE_ID, isArchived: true }), shareViews: async () => STATS },
      { docId: DOC_ID, days: 60 },
    );

    expect(out.isArchived).toBe(true);
    const warnings = out.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/archived/i);
    expect(warnings[0]).toMatch(/none of its links resolve/i);
    // The remedy has to be the call that actually undoes it, as in every sibling tool.
    expect(warnings[0]).toMatch(/lnkdrp_archive_doc \{ archived: false \}/);
    // downloadsEnabled is explained, not flipped: false is documented as "nobody was ever able to
    // download it", which would be a fresh lie about a document that was downloaded twice.
    expect(out.downloadsEnabled).toBe(true);
    expect(warnings[0]).toMatch(/downloadsEnabled/);
    // The history itself is true and must survive untouched.
    expect(out.totals).toEqual(STATS.totals);
    expect(out.viewerCount).toBe(3);
  });

  it("flags it on the per-link form too", async () => {
    // docId + shareId is the shape the tool's own description recommends for a non-default link,
    // and the shareId-only path's refusal hands the agent exactly this shape.
    const out = await stats(
      { getDoc: async () => ({ id: DOC_ID, shareId: "default", isArchived: true }), shareViews: async () => ({ ...STATS, totals: { ...STATS.totals, views: 1 } }) },
      { docId: DOC_ID, shareId: SHARE_ID },
    );

    expect(out.perLink).toBe(true);
    expect(out.isArchived).toBe(true);
    expect((out.warnings as string[])[0]).toMatch(/archived/i);
  });

  it("says nothing about archiving on a live document", async () => {
    const out = await stats(
      { getDoc: async () => ({ id: DOC_ID, shareId: SHARE_ID, isArchived: false }), shareViews: async () => STATS },
      { docId: DOC_ID },
    );

    expect(out.isArchived).toBeUndefined();
    expect(out.warnings).toBeUndefined();
  });
});

describe("get_share_stats on a deleted link", () => {
  it("names deletion instead of sending the caller round a loop", async () => {
    // Deleting a link soft-archives the row, so the shareviews route (which filters archivedAt:
    // null) 404s. The old message said "Pass the docId the link belongs to, or omit docId" to a
    // caller who had just passed that docId, and never mentioned deletion; find_share_link, the
    // escape hatch it named, lists live links only and so confirmed the wrong conclusion that the
    // link had never existed.
    const err = await failure(
      {
        getDoc: async () => ({ id: DOC_ID, shareId: "default", isArchived: false }),
        shareViews: async () => {
          throw new ToolError("not_found", "No such document in this workspace.", { status: 404 });
        },
      },
      { docId: DOC_ID, shareId: SHARE_ID },
    );

    expect(err.code).toBe("not_found");
    expect(err.message).toContain(SHARE_ID);
    expect(err.message).toMatch(/deleted/i);
    // The advice the caller has already followed, and which cost them a round trip.
    expect(err.message).not.toMatch(/Pass the docId/);
    // Where the deleted link's traffic did go, since it is not lost.
    expect(err.message).toMatch(/totals/);
  });
});
