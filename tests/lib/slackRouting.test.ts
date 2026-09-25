/**
 * Which channels an event reaches, and how many posts a minute a channel takes
 * (docs/prds/lnkdrp-slack.md, decisions 2 and 10, verification 9 and 13).
 */
import { describe, expect, test } from "vitest";

import { burstAllowance, routeSlackConnections, SLACK_BURST_PER_MINUTE, type RoutableConnection } from "@/lib/slack/routing";
import { slackBurstMessage } from "@/lib/slack/messages";

const on = { views: true, briefs: true, docUpdates: true, requests: true, docs: true };
const conn = (id: string, extra: Partial<RoutableConnection> = {}): RoutableConnection => ({ id, isDefault: false, status: "active", projectIds: [], events: { ...on }, ...extra });

describe("routing", () => {
  const deals = conn("deals", { isDefault: true });
  const acme = conn("acme", { projectIds: ["p-acme"] });
  const north = conn("north", { projectIds: ["p-north"] });

  test("a workspace with only a default sends everything there", () => {
    expect(routeSlackConnections([deals], "views", []).map((c) => c.id)).toEqual(["deals"]);
    expect(routeSlackConnections([deals], "views", ["p-acme"]).map((c) => c.id)).toEqual(["deals"]);
  });

  test("a document in a mapped project posts only to that channel", () => {
    expect(routeSlackConnections([deals, acme, north], "views", ["p-acme"]).map((c) => c.id)).toEqual(["acme"]);
  });

  test("a document in two mapped rooms posts to both; unmapped goes to the default", () => {
    expect(routeSlackConnections([deals, acme, north], "briefs", ["p-acme", "p-north"]).map((c) => c.id)).toEqual(["acme", "north"]);
    expect(routeSlackConnections([deals, acme, north], "briefs", ["p-other"]).map((c) => c.id)).toEqual(["deals"]);
    expect(routeSlackConnections([deals, acme, north], "briefs", []).map((c) => c.id)).toEqual(["deals"]);
  });

  test("a switch that is off, or a revoked channel, receives nothing; the default can be skipped too", () => {
    const quiet = conn("acme", { projectIds: ["p-acme"], events: { ...on, views: false } });
    expect(routeSlackConnections([deals, quiet], "views", ["p-acme"]).map((c) => c.id)).toEqual(["deals"]);
    const gone = conn("deals", { isDefault: true, status: "revoked" });
    expect(routeSlackConnections([gone, acme], "views", [])).toEqual([]);
    const defOff = conn("deals", { isDefault: true, events: { ...on, docUpdates: false } });
    expect(routeSlackConnections([defOff, acme], "docUpdates", [])).toEqual([]);
    expect(routeSlackConnections([], "views", ["p-acme"])).toEqual([]);
  });

  test("a contained document goes to its room's channel or nowhere, never the catch-all", () => {
    expect(routeSlackConnections([deals, acme, north], "views", ["p-acme"], { allowDefault: false }).map((c) => c.id)).toEqual(["acme"]);
    expect(routeSlackConnections([deals, acme, north], "views", ["p-other"], { allowDefault: false })).toEqual([]);
    expect(routeSlackConnections([deals], "views", [], { allowDefault: false })).toEqual([]);
  });

  test("disconnecting a mapped channel sends its projects back to the default", () => {
    expect(routeSlackConnections([deals, north], "views", ["p-acme"]).map((c) => c.id)).toEqual(["deals"]);
  });
});

describe("the burst cap", () => {
  test("thirty a minute, the rest held", () => {
    expect(burstAllowance(0, 40)).toEqual({ allowed: SLACK_BURST_PER_MINUTE, held: 40 - SLACK_BURST_PER_MINUTE });
    expect(burstAllowance(25, 10)).toEqual({ allowed: 5, held: 5 });
    expect(burstAllowance(30, 3)).toEqual({ allowed: 0, held: 3 });
    expect(burstAllowance(0, 3)).toEqual({ allowed: 3, held: 0 });
    expect(burstAllowance(-1, -1)).toEqual({ allowed: 0, held: 0 });
  });

  test("the channel is told once how many are waiting", () => {
    const m = slackBurstMessage({ held: 10, cap: 30 });
    expect(m.text).toContain("10 more");
    expect(m.text).toContain("30 a minute");
    expect(m.blocks).toHaveLength(1);
  });
});

describe("one project, one channel (source contract)", () => {
  test("mapping a project on one card pulls it from every other card in the workspace", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/orgs/active/slack/route.ts", "utf8");
    expect(src).toMatch(/\$pull: \{ projectIds: \{ \$in: set\.projectIds \} \}/);
    expect(src).toMatch(/_id: \{ \$ne: connectionId \} \}, \{ \$pull/);
  });

  test("the picker offers a project already routed elsewhere with that channel's name", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/integrations/slack/pageClient.tsx", "utf8");
    expect(src).toContain("now on ${other}");
    expect(src).toContain("/api/requests");
  });
});
