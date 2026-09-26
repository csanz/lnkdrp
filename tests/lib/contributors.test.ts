/**
 * Who is credited with a document, and who is deliberately not.
 *
 * Three rules carry the whole design, and each was a decision rather than an accident:
 *
 * - **Reading is not contributing.** The actor on a view is the recipient. Without the work-type
 *   filter, the most prolific "contributor" to every document would be whoever read it most.
 * - **A request drop-off is not a contribution.** The secret-auth path synthesises its actor from
 *   the repo owner, so counting it credits the owner with a stranger's upload — the same
 *   misattribution that had to be fixed in the new-document email.
 * - **The author is not also a contributor.** They are shown in their own right; listing them
 *   twice reads as two people.
 * - **An agent is credited to its client under the member who connected it.** Two members who each
 *   connect Claude Code are two contributors, not one: crediting both to `agent:claude-code` would
 *   print one member's filing under the other's name. The key carries the owner, and every row
 *   carries the `href` of the page that lists everything that contributor did.
 */
import { describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const DOC = new Types.ObjectId();
const ALICE = new Types.ObjectId();
const BOB = new Types.ObjectId();
const CARLA = new Types.ObjectId();

let events: Array<Record<string, unknown>> = [];

function chain(rows: unknown[]) {
  return { select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) };
}
function userChain(rows: unknown[]) {
  return { select: () => ({ lean: async () => rows }) };
}

vi.mock("@/lib/models/ActivityEvent", () => ({
  ActivityEventModel: { find: (..._a: unknown[]) => chain(events) },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: () =>
      userChain([
        { _id: ALICE, name: "Alice Ng", email: "alice@example.com" },
        { _id: BOB, name: "", email: "bob@example.com" },
        { _id: CARLA, name: "Carla Reyes", email: "carla@example.com" },
      ]),
  },
}));

const { loadAuthorship } = await import("@/lib/people/contributors");

function ev(over: Record<string, unknown>) {
  return { userId: BOB, actorKind: "user", agent: null, createdDate: new Date("2026-09-20T10:00:00Z"), ...over };
}

describe("authorship", () => {
  test("the creator is the author, and is not repeated among contributors", async () => {
    events = [ev({ userId: ALICE }), ev({ userId: BOB })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.author?.name).toBe("Alice Ng");
    expect(res.author?.key).toBe(`user:${ALICE}`);
    expect(res.author?.href).toBe(`/people/${ALICE}`);
    // The author is excluded by their `user:` key, not by a bare id: the two are different strings
    // and comparing the wrong one would list the author twice.
    expect(res.contributors.map((c) => c.key)).toEqual([`user:${BOB}`]);
  });

  test("a person with no name falls back to the local part, never to an empty label", async () => {
    events = [ev({ userId: BOB })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors[0]!.name).toBe("bob");
  });

  test("readers and anonymous sessions never appear", async () => {
    events = [ev({ actorKind: "viewer" }), ev({ actorKind: "temp" })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors).toEqual([]);
  });

  test("a request-inbox drop-off does not credit the repo owner", async () => {
    // actorKind "secret" is the path whose actor is synthesised from the Upload's owner.
    events = [ev({ actorKind: "secret", userId: ALICE })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: BOB, scope: { docId: String(DOC) } });
    expect(res.contributors).toEqual([]);
  });

  test("an agent is credited to its client under the member who connected it", async () => {
    events = [ev({ actorKind: "api_key", userId: BOB, agent: { client: "northwind-seed" } })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors[0]).toMatchObject({
      key: `agent:northwind-seed@${BOB}`,
      kind: "agent",
      name: "Northwind Seed",
      ownerUserId: String(BOB),
      href: `/agents/northwind-seed/${BOB}`,
    });
    // The row is the agent's work, so it never borrows the owner's address.
    expect(res.contributors[0]!.email).toBeNull();
  });

  test("the same client connected by two members is two contributors", async () => {
    events = [
      ev({ actorKind: "api_key", userId: BOB, agent: { client: "claude-code" } }),
      ev({ actorKind: "api_key", userId: CARLA, agent: { client: "claude-code" } }),
    ];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors).toHaveLength(2);
    expect(new Set(res.contributors.map((c) => c.key))).toEqual(
      new Set([`agent:claude-code@${BOB}`, `agent:claude-code@${CARLA}`]),
    );
    // Both are called "Claude Code"; the owner is what tells them apart.
    expect(res.contributors.every((c) => c.name === "Claude Code")).toBe(true);
    expect(new Set(res.contributors.map((c) => c.ownerUserId))).toEqual(new Set([String(BOB), String(CARLA)]));
  });

  test("an agent with no recorded owner groups under the unknown owner", async () => {
    events = [ev({ actorKind: "api_key", userId: null, agent: { client: "claude-code" } })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors[0]).toMatchObject({
      key: "agent:claude-code@unknown",
      ownerUserId: null,
      href: "/agents/claude-code/unknown",
    });
  });

  test("an agent's name is the label the rest of the product prints, not a Title Case guess", async () => {
    events = [ev({ actorKind: "api_key", userId: BOB, agent: { client: "gemini-cli" } })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    // Title Casing the id would say "Gemini Cli"; `agentLabel` is the one place these are spelled.
    expect(res.contributors[0]!.name).toBe("Gemini CLI");
  });

  test("every row carries the page that lists what that contributor did", async () => {
    events = [
      ev({ userId: BOB }),
      ev({ actorKind: "api_key", userId: CARLA, agent: { client: "claude-code" } }),
    ];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.author?.href).toBe(`/people/${ALICE}`);
    expect(res.contributors.every((c) => typeof c.href === "string" && c.href!.startsWith("/"))).toBe(true);
  });

  test("contributors are ordered by most recent work", async () => {
    events = [
      ev({ userId: BOB, createdDate: new Date("2026-09-01T00:00:00Z") }),
      ev({ actorKind: "api_key", agent: { client: "lnkdrp-e2e" }, createdDate: new Date("2026-09-21T00:00:00Z") }),
    ];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors.map((c) => c.kind)).toEqual(["agent", "person"]);
  });

  test("a caller that resolved no scope gets nothing, not the whole workspace", async () => {
    events = [ev({})];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: {} });
    expect(res).toEqual({ author: null, contributors: [] });
  });
});
