/**
 * The contributor key, which is the one thing every surface in this feature agrees on.
 *
 * Two properties are load-bearing and are what these tests are really about:
 *
 * - **An agent key carries its owner.** Two members who each connect Claude Code must produce two
 *   different keys, or one member's filing appears under the other's name. Every agent key that
 *   leaves this module therefore spells its owner, and `@unknown` is a real owner rather than an
 *   omission.
 * - **Parsing is strict, because a key becomes a Mongo filter and a URL.** Anything that is not
 *   exactly a 24-hex id or a normalised client id is rejected here rather than reaching a query as
 *   a filter on nothing, or a route as a path it cannot round-trip.
 */
import { describe, expect, test } from "vitest";

import {
  UNKNOWN_OWNER,
  agentKey,
  contributorHref,
  formatContributorKey,
  keyFromActivityRow,
  keyFromRoute,
  parseContributorKey,
  personKey,
  type ContributorKey,
} from "@/lib/people/contributorKey";

const ALICE = "6ab46f3a542dc85d9d3ba00f";
const BOB = "6ab46f3add6983534677931d";

describe("parse and format round-trip", () => {
  test.each<[string, ContributorKey]>([
    [`user:${ALICE}`, { kind: "person", userId: ALICE }],
    [`agent:claude-code@${ALICE}`, { kind: "agent", client: "claude-code", ownerUserId: ALICE }],
    ["agent:claude-code@unknown", { kind: "agent", client: "claude-code", ownerUserId: null }],
    ["agent:gemini-cli@unknown", { kind: "agent", client: "gemini-cli", ownerUserId: null }],
  ])("%s parses and formats back to itself", (raw, expected) => {
    const parsed = parseContributorKey(raw);
    expect(parsed).toEqual(expected);
    expect(formatContributorKey(parsed!)).toBe(raw);
  });

  test("the same client under two owners is two different keys", () => {
    expect(agentKey("claude-code", ALICE)).not.toBe(agentKey("claude-code", BOB));
    expect(parseContributorKey(agentKey("claude-code", ALICE))).toEqual({
      kind: "agent",
      client: "claude-code",
      ownerUserId: ALICE,
    });
  });

  test("a legacy owner-less key still parses, as the unknown owner, and re-formats with @unknown", () => {
    const parsed = parseContributorKey("agent:claude-code");
    expect(parsed).toEqual({ kind: "agent", client: "claude-code", ownerUserId: null });
    // Nothing emits the legacy form any more: a stored one is upgraded the moment it is read.
    expect(formatContributorKey(parsed!)).toBe(`agent:claude-code@${UNKNOWN_OWNER}`);
  });

  test("a missing owner serialises as unknown rather than as an empty segment", () => {
    expect(agentKey("cursor", null)).toBe("agent:cursor@unknown");
    expect(agentKey("cursor", undefined)).toBe("agent:cursor@unknown");
    expect(agentKey("cursor", "")).toBe("agent:cursor@unknown");
    expect(personKey(ALICE)).toBe(`user:${ALICE}`);
  });
});

describe("what is rejected", () => {
  test.each([
    ["user:abc", "a user id that is not 24 hex"],
    [`user:${ALICE.slice(0, 23)}`, "a 23-hex user id"],
    [`user:${ALICE.toUpperCase()}`, "an uppercase user id"],
    ["agent:Claude Code@" + ALICE, "a client id with a space and capitals"],
    ["agent:Claude-Code@" + ALICE, "an uppercase client id"],
    ["agent:claude-code@notanid", "an owner that is not an id and is not unknown"],
    ["agent:@" + ALICE, "an empty client id"],
    ["agent:", "an empty agent key"],
    ["", "an empty string"],
    ["   ", "whitespace"],
    [ALICE, "a bare user id with no prefix"],
    ["viewer:" + ALICE, "a prefix this product does not address"],
    ["agent:" + "x".repeat(65) + "@" + ALICE, "a client id past the 64-character cap"],
  ])("%s is not a contributor key (%s)", (raw) => {
    expect(parseContributorKey(raw)).toBeNull();
    expect(contributorHref(raw)).toBeNull();
  });
});

describe("hrefs", () => {
  test("a person's page and an agent's page", () => {
    expect(contributorHref({ kind: "person", userId: ALICE })).toBe(`/people/${ALICE}`);
    expect(contributorHref({ kind: "agent", client: "claude-code", ownerUserId: ALICE })).toBe(
      `/agents/claude-code/${ALICE}`,
    );
    expect(contributorHref({ kind: "agent", client: "claude-code", ownerUserId: null })).toBe(
      "/agents/claude-code/unknown",
    );
  });

  test("each segment is encoded, so a key can never break out of its path", () => {
    // `.` is legal in a client id and must survive; nothing else in the grammar needs escaping, so
    // the guarantee is that the encoder runs per segment rather than over the joined string.
    expect(contributorHref({ kind: "agent", client: "a.b_c-d", ownerUserId: ALICE })).toBe(
      `/agents/a.b_c-d/${ALICE}`,
    );
    expect(contributorHref({ kind: "agent", client: "a/b", ownerUserId: null })).toBe("/agents/a%2Fb/unknown");
  });
});

describe("keyFromRoute", () => {
  test("the two page routes resolve to the keys their pages are about", () => {
    expect(keyFromRoute({ userId: ALICE })).toEqual({ kind: "person", userId: ALICE });
    expect(keyFromRoute({ client: "claude-code", ownerUserId: ALICE })).toEqual({
      kind: "agent",
      client: "claude-code",
      ownerUserId: ALICE,
    });
    expect(keyFromRoute({ client: "claude-code", ownerUserId: "unknown" })).toEqual({
      kind: "agent",
      client: "claude-code",
      ownerUserId: null,
    });
  });

  test("a hand-typed URL that is not a contributor resolves to null, so the page can 404", () => {
    expect(keyFromRoute({ userId: "nope" })).toBeNull();
    expect(keyFromRoute({ client: "claude code", ownerUserId: ALICE })).toBeNull();
    expect(keyFromRoute({ client: "claude-code", ownerUserId: "somebody" })).toBeNull();
  });
});

describe("keyFromActivityRow", () => {
  test("a row with a client is the agent's, owned by the row's user", () => {
    expect(keyFromActivityRow({ userId: ALICE, agent: { client: "claude-code" } })).toEqual({
      kind: "agent",
      client: "claude-code",
      ownerUserId: ALICE,
    });
  });

  test("a client row with no user is the unknown owner, not a person", () => {
    expect(keyFromActivityRow({ userId: null, agent: { client: "claude-code" } })).toEqual({
      kind: "agent",
      client: "claude-code",
      ownerUserId: null,
    });
  });

  test("a row without a client belongs to the person who acted", () => {
    expect(keyFromActivityRow({ userId: ALICE, agent: null })).toEqual({ kind: "person", userId: ALICE });
    expect(keyFromActivityRow({ userId: ALICE })).toEqual({ kind: "person", userId: ALICE });
  });

  test("a system row belongs to nobody rather than to whoever is nearby", () => {
    expect(keyFromActivityRow({ userId: null, agent: null })).toBeNull();
    expect(keyFromActivityRow({})).toBeNull();
  });
});
