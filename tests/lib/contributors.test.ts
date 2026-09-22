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
 */
import { describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const DOC = new Types.ObjectId();
const ALICE = new Types.ObjectId();
const BOB = new Types.ObjectId();

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
    expect(res.contributors.map((c) => c.key)).toEqual([String(BOB)]);
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

  test("an agent is credited, under its key, and marked as an agent", async () => {
    events = [ev({ actorKind: "api_key", userId: BOB, agent: { client: "northwind-seed" } })];
    const res = await loadAuthorship({ orgId: ORG, creatorUserId: ALICE, scope: { docId: String(DOC) } });
    expect(res.contributors[0]).toMatchObject({ key: "agent:northwind-seed", kind: "agent", name: "Northwind Seed" });
    // Two people sharing one key are one contributor; the key is the identity the product has.
    expect(res.contributors[0]!.email).toBeNull();
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
