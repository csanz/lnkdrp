/**
 * "Who contributed" on the workspace metrics page, now that every row is a link.
 *
 * The change this pins is that an agent row is keyed by `(client, owner)` rather than by the client
 * alone. Two members who each connect Claude Code used to collapse into one row whose label was
 * "Claude Code" and whose counts were both members' work added together; the page said one thing
 * had happened where two had. The row still says "Claude Code" (the agent did the work, not its
 * owner) and names the owner on a second line, which is also the only way to tell two rows with the
 * same label apart.
 *
 * `href` is asserted on every row for the same reason it exists: the row is the entry point to that
 * contributor's page, and a row whose link is missing is a dead end the UI cannot detect.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const ALICE = new Types.ObjectId("6ab46f3a542dc85d9d3ba00f");
const BOB = new Types.ObjectId("6ab46f3add6983534677931d");

let rows: unknown[] = [];
let users: Array<Record<string, unknown>> = [];

vi.mock("@/lib/models/ActivityEvent", () => ({
  ActivityEventModel: { aggregate: async () => rows },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: (q: { _id?: { $in?: Types.ObjectId[] } }) => ({
      select: () => ({
        lean: async () => {
          const want = new Set((q?._id?.$in ?? []).map((v) => String(v)));
          return users.filter((u) => want.has(String(u._id)));
        },
      }),
    }),
  },
}));

const { loadContributors } = await import("@/lib/analytics/workspace/contributors");

const WINDOW = { orgId: ORG, start: new Date("2026-09-01T00:00:00Z"), endExclusive: new Date("2026-10-01T00:00:00Z") };
const AT = new Date("2026-09-20T00:00:00Z");

/** One `{ userId, client, type }` bucket as the aggregate returns it. */
function row(over: Record<string, unknown>) {
  return { n: 1, lastAt: AT, ...over, _id: { userId: null, client: null, type: "doc.created", ...(over._id as object) } };
}

beforeEach(() => {
  rows = [];
  users = [
    { _id: ALICE, name: "Alice Ng", email: "alice@example.com" },
    { _id: BOB, name: "", email: "bob@example.com" },
  ];
});

describe("people", () => {
  test("a member's row is keyed and linked by their id", async () => {
    rows = [row({ _id: { userId: ALICE }, n: 4 })];
    const [c] = await loadContributors(WINDOW);
    expect(c).toMatchObject({
      key: `user:${ALICE}`,
      kind: "person",
      name: "Alice Ng",
      email: "alice@example.com",
      href: `/people/${ALICE}`,
      ownerUserId: null,
      ownerName: null,
      actions: 4,
      docsAdded: 4,
    });
  });

  test("a member with no name is still named, by their address", async () => {
    rows = [row({ _id: { userId: BOB } })];
    const [c] = await loadContributors(WINDOW);
    expect(c!.name).toBe("bob@example.com");
  });
});

describe("agents", () => {
  test("an agent row keeps the owner, names them, and links to its own page", async () => {
    rows = [row({ _id: { userId: ALICE, client: "claude-code" }, n: 9 })];
    const [c] = await loadContributors(WINDOW);
    expect(c).toMatchObject({
      key: `agent:claude-code@${ALICE}`,
      kind: "agent",
      // The agent did the work: the row is not relabelled with the owner's name.
      name: "Claude Code",
      client: "claude-code",
      ownerUserId: String(ALICE),
      ownerName: "Alice Ng",
      email: null,
      href: `/agents/claude-code/${ALICE}`,
      actions: 9,
    });
  });

  test("the same client under two members is two rows, not one", async () => {
    rows = [
      row({ _id: { userId: ALICE, client: "claude-code" }, n: 9 }),
      row({ _id: { userId: BOB, client: "claude-code" }, n: 2 }),
    ];
    const out = await loadContributors(WINDOW);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.key)).toEqual([`agent:claude-code@${ALICE}`, `agent:claude-code@${BOB}`]);
    expect(out.map((c) => c.actions)).toEqual([9, 2]);
    // Same label, different owners: the second line is what tells the reader which is which.
    expect(out.map((c) => c.name)).toEqual(["Claude Code", "Claude Code"]);
    expect(out.map((c) => c.ownerName)).toEqual(["Alice Ng", "bob@example.com"]);
  });

  test("owners are resolved in the same lookup as the people, not one query per agent", async () => {
    const find = vi.spyOn(
      (await import("@/lib/models/User")).UserModel as unknown as { find: (q: unknown) => unknown },
      "find",
    );
    rows = [
      row({ _id: { userId: ALICE, client: "claude-code" } }),
      row({ _id: { userId: BOB } }),
    ];
    const out = await loadContributors(WINDOW);
    expect(find).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.ownerName ?? c.name)).toEqual(["Alice Ng", "bob@example.com"]);
    find.mockRestore();
  });

  test("an agent with no recorded owner is the unknown owner, with no name to print", async () => {
    rows = [row({ _id: { userId: null, client: "claude-code" }, n: 3 })];
    const [c] = await loadContributors(WINDOW);
    expect(c).toMatchObject({
      key: "agent:claude-code@unknown",
      ownerUserId: null,
      ownerName: null,
      href: "/agents/claude-code/unknown",
    });
  });
});

describe("what is not a contributor", () => {
  test("a row with neither an agent nor a member belongs to nobody", async () => {
    rows = [row({ _id: {} })];
    expect(await loadContributors(WINDOW)).toEqual([]);
  });

  test("every row that does survive can be clicked", async () => {
    rows = [
      row({ _id: { userId: ALICE }, n: 5 }),
      row({ _id: { userId: BOB, client: "gemini-cli" }, n: 4 }),
      row({ _id: { userId: null, client: "cursor" }, n: 3 }),
    ];
    const out = await loadContributors(WINDOW);
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.href.startsWith("/people/") || c.href.startsWith("/agents/"))).toBe(true);
  });
});
