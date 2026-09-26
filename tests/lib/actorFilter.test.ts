/**
 * The clauses that mean "this one contributor".
 *
 * The rule worth a test of its own is the parity one: a person's page must select exactly what the
 * feed's `who=me` selects, or the same member's history reads differently on two screens of the
 * same product. The easy way to get it wrong is to match `userId` alone, which sweeps in every row
 * that member's agents wrote under their credential; the second easy way is to forget the
 * `actorKind` exclusion, which sweeps in the rows where they were the *recipient* rather than the
 * actor. The last test reads the feed route's own source so that changing `who=me` without changing
 * this filter fails here rather than in production.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { Types } from "mongoose";

import { buildActorFilter } from "@/lib/people/actorFilter";

const ALICE = "6ab46f3a542dc85d9d3ba00f";

describe("buildActorFilter", () => {
  test("a person: their own actions, never their agents', never their reading", () => {
    const filter = buildActorFilter({ kind: "person", userId: ALICE });
    expect(filter).toEqual({
      userId: new Types.ObjectId(ALICE),
      "agent.client": { $exists: false },
      actorKind: { $nin: ["viewer", "secret"] },
    });
    expect(String(filter.userId)).toBe(ALICE);
  });

  test("an agent: this client, under this owner", () => {
    const filter = buildActorFilter({ kind: "agent", client: "claude-code", ownerUserId: ALICE });
    expect(filter).toEqual({
      userId: new Types.ObjectId(ALICE),
      "agent.client": "claude-code",
    });
    // No actorKind clause: every agent row is an agent row, whatever it authenticated as.
    expect(filter).not.toHaveProperty("actorKind");
  });

  test("an agent with no recorded owner selects the rows that have none, not every owner's", () => {
    expect(buildActorFilter({ kind: "agent", client: "claude-code", ownerUserId: null })).toEqual({
      userId: null,
      "agent.client": "claude-code",
    });
  });

  test("the same client under two owners produces two different filters", () => {
    const BOB = "6ab46f3add6983534677931d";
    const a = buildActorFilter({ kind: "agent", client: "claude-code", ownerUserId: ALICE });
    const b = buildActorFilter({ kind: "agent", client: "claude-code", ownerUserId: BOB });
    expect(String(a.userId)).not.toBe(String(b.userId));
  });
});

describe("parity with the feed's who=me", () => {
  test("the person branch is the same three clauses the activity route applies", () => {
    const routePath = path.resolve(__dirname, "../../src/app/api/activity/route.ts");
    const source = fs.readFileSync(routePath, "utf8");
    const start = source.indexOf('who === "me"');
    const end = source.indexOf('who === "team"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);

    // If any of these three stops being true of `who=me`, a person's page and the feed have started
    // disagreeing about what that person did, and `buildActorFilter` has to move with it.
    expect(branch).toContain("filter.userId = new Types.ObjectId(actor.userId)");
    expect(branch).toContain('filter["agent.client"] = { $exists: false }');
    expect(branch).toContain('filter.actorKind = { $nin: ["viewer", "secret"] }');

    const mine = buildActorFilter({ kind: "person", userId: ALICE });
    expect(Object.keys(mine).sort()).toEqual(["actorKind", "agent.client", "userId"]);
    expect(mine["agent.client"]).toEqual({ $exists: false });
    expect(mine.actorKind).toEqual({ $nin: ["viewer", "secret"] });
  });
});
