/**
 * The activity donut's legend links each agent to its own page.
 *
 * An agent is a contributor as "this client, connected by this person", so a slice can only carry
 * a link when the window shows exactly one member behind that client. Two members who each
 * connected Claude Code are two contributors with two pages, and the slice adds their work
 * together, so there is no single page it could honestly point at.
 */
import { describe, expect, it } from "vitest";

import { groupActorSlices, type ActivityGroupRow } from "@/lib/activity/summary";

const ALICE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "bbbbbbbbbbbbbbbbbbbbbbbb";

function row(over: Partial<ActivityGroupRow>): ActivityGroupRow {
  return { type: "doc.created", client: null, label: null, ownerUserId: null, count: 1, ...over };
}

describe("actor slice links", () => {
  it("links an agent one member connected", () => {
    const { slices } = groupActorSlices([
      row({ client: "claude-code", label: "Claude Code", ownerUserId: ALICE, count: 5 }),
    ]);
    const agent = slices.find((s) => s.kind === "agent");
    expect(agent?.ownerUserId).toBe(ALICE);
    expect(agent?.href).toBe(`/agents/claude-code/${ALICE}`);
  });

  it("leaves an agent two members connected unlinked, and still counts all of its work", () => {
    const { slices } = groupActorSlices([
      row({ client: "claude-code", label: "Claude Code", ownerUserId: ALICE, count: 5 }),
      row({ client: "claude-code", label: "Claude Code", ownerUserId: BOB, count: 3 }),
    ]);
    const agent = slices.find((s) => s.kind === "agent");
    // One slice for the client, the sum of both members' work, and no link to either of them.
    expect(slices.filter((s) => s.kind === "agent")).toHaveLength(1);
    expect(agent?.count).toBe(8);
    expect(agent?.ownerUserId).toBeNull();
    expect(agent?.href).toBeNull();
  });

  it("leaves an agent whose rows carry no owner unlinked", () => {
    const { slices } = groupActorSlices([row({ client: "old-client", label: "Old Client", count: 2 })]);
    const agent = slices.find((s) => s.kind === "agent");
    expect(agent?.ownerUserId).toBeNull();
    expect(agent?.href).toBeNull();
  });

  it("never links the people slice or the folded tail", () => {
    const many: ActivityGroupRow[] = [row({ count: 4 })];
    for (let i = 0; i < 9; i++) {
      many.push(row({ client: `client-${i}`, label: `Client ${i}`, ownerUserId: ALICE, count: 9 - i }));
    }
    const { slices } = groupActorSlices(many, { maxNamedAgents: 2 });
    expect(slices.find((s) => s.kind === "people")?.href).toBeNull();
    const tail = slices.find((s) => s.kind === "other");
    expect(tail?.href).toBeNull();
    expect(tail?.ownerUserId).toBeNull();
  });
});
