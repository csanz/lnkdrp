/**
 * `lnkdrp_whoami`'s price list has to be the app's price list.
 *
 * Two surfaces explain what lnkdrp's AI costs: `/costs` and `/pricing` render
 * `src/lib/credits/costCatalog.ts`, and an agent reads `lnkdrp_whoami`. They were built
 * independently from `creditsForRun`, so they agreed on the numbers and disagreed on the thing that
 * matters more: whether there is a level to choose. The catalog was corrected to advertise the
 * summary and the visit brief as one price with no level, because every code path pins the summary
 * to basic and no tool or screen offers a level for either. whoami kept returning
 * `costs: { summary: [1,2,5], compare: [2,5,12], brief: [1,1,1] }` against
 * `costTiers: ["basic","standard","advanced"]`, which reads as three orderable summaries, two of
 * which cannot be ordered. An agent cannot check that against anything; it repeats it to a person
 * as fact and budgets against it.
 *
 * These tests hold the two equal per action rather than against any particular number, so a
 * deliberate repricing stays a one-line edit in `schedule.ts` and a one-sided change to either
 * surface fails here.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { COST_CATALOG, QUALITY_TIERS, flatPriceOf, hasQualityLevels } from "@/lib/credits/costCatalog";
import type { ActionType } from "@/lib/credits/types";
import type { ToolContext } from "../../mcp/src/context";
import { COST_TIERS, creditCosts, registerWhoamiTool, type AdvertisedCost } from "../../mcp/src/tools/whoami";

/** Which whoami cost row answers for which catalog action, since whoami renames two of them. */
const ROWS: ReadonlyArray<{ row: keyof ReturnType<typeof creditCosts>; action: ActionType }> = [
  { row: "summary", action: "summary" },
  { row: "compare", action: "history" },
  { row: "brief", action: "brief" },
];

/** The catalog entry for an action, or a failure naming the action rather than a null dereference. */
function catalogEntry(action: ActionType) {
  const entry = COST_CATALOG.find((e) => e.action === action);
  if (!entry) throw new Error(`no cost catalog row for "${action}"`);
  return entry;
}

describe("lnkdrp_whoami costs match the app's cost catalog", () => {
  for (const { row, action } of ROWS) {
    it(`${row} offers exactly the levels the catalog says are pickable`, () => {
      // The whole point. Equal numbers with unequal `levels` is the bug this file exists for: the
      // agent is told about a choice the product has no way to take.
      const entry = catalogEntry(action);
      expect([...creditCosts()[row].levels]).toEqual([...entry.levels]);
    });

    it(`${row} prices every level the way the catalog prices it`, () => {
      const entry = catalogEntry(action);
      expect(creditCosts()[row].perLevel).toEqual(entry.costs);
    });

    it(`${row} states a single price exactly when there is nothing to pick`, () => {
      // `credits` is the field an agent reads to budget one run without branching on a tier it
      // cannot see. Non-null must mean "this is what you will be charged", so it may only be set
      // when the level is not a variable.
      const entry = catalogEntry(action);
      const advertised: AdvertisedCost = creditCosts()[row];
      expect(advertised.credits).toBe(hasQualityLevels(entry) ? null : flatPriceOf(entry));
    });
  }

  it("names the same quality levels the app does, in the same order", () => {
    // costTiers is the product's list of levels; a row's own `levels` is the subset it offers.
    // If the two lists ever diverge the per-row comparison above would pass on a different alphabet.
    expect([...COST_TIERS]).toEqual([...QUALITY_TIERS]);
  });

  it("covers every released, chargeable action the catalog lists", () => {
    // The list above is hand-written; this is the check that it is not short. A released row the
    // MCP never prices is a price an agent has to guess at.
    const released = COST_CATALOG.filter((e) => e.released && e.action !== null).map((e) => e.action);
    expect([...released].sort()).toEqual(ROWS.map((r) => r.action).sort());
  });
});

describe("the whoami payload carries that price list", () => {
  /** Register whoami on an in-memory pair and return a caller, with the snapshots it reaches for. */
  async function callWhoami(): Promise<Record<string, unknown>> {
    const server = new McpServer({ name: "test", version: "1" });
    registerWhoamiTool(server, {
      api: {
        whoami: async () => ({ ok: true, orgId: "o1", orgName: "Personal", plan: "free" }),
        creditsSnapshot: async () => null,
        planSnapshot: async () => null,
      },
      config: { featureRequestsEnabled: false },
      whoami: () => ({ orgId: "o1", orgName: "Personal" }),
      setWhoami: () => {},
    } as unknown as ToolContext);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const res = await client.callTool({ name: "lnkdrp_whoami", arguments: {} });
    return res.structuredContent as Record<string, unknown>;
  }

  it("ships the rows an agent actually receives, not just the builder's return", async () => {
    // Everything above tests `creditCosts()`. This is the one that proves the payload is built
    // from it, so the assertions are about what a connected agent reads.
    const out = await callWhoami();
    expect(out.costs).toEqual(creditCosts());
  });

  it("advertises no unpickable summary or brief price to an agent", async () => {
    // Stated as the wrong answer rather than as a shape: an agent that reads whoami must not be
    // able to find a second price for the summary anywhere in it.
    const out = await callWhoami();
    const costs = out.costs as ReturnType<typeof creditCosts>;
    expect(costs.summary.levels).toEqual([]);
    expect(costs.brief.levels).toEqual([]);
    expect(new Set(Object.values(costs.summary.perLevel)).size).toBe(1);
    expect(new Set(Object.values(costs.brief.perLevel)).size).toBe(1);
  });

  it("tells the agent in prose what the shape says, and quotes the real number", async () => {
    // The description is a price quote of its own; the round-seven test pins that it says the
    // automatic summary is always basic, this pins that the number beside those words is the
    // charged one.
    const server = new McpServer({ name: "test", version: "1" });
    registerWhoamiTool(server, { api: {}, config: {}, whoami: () => ({}), setWhoami: () => {} } as unknown as ToolContext);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const listed = await client.listTools();
    const description = listed.tools.find((t) => t.name === "lnkdrp_whoami")?.description ?? "";
    expect(description).toContain(`always billed at basic (${flatPriceOf(catalogEntry("summary"))} credit)`);
  });
});
