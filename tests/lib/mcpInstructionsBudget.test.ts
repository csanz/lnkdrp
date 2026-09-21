import { describe, expect, test } from "vitest";

import { SERVER_INSTRUCTIONS, workspaceInstructions } from "../../mcp/src/server";

/**
 * The instructions block has a hard budget, because clients truncate it silently.
 *
 * Measured live: a client delivered the first 2,048 characters and dropped the rest without a word.
 * The block had grown to roughly 3,200, so a third of it never arrived — project links, tags, the
 * document-lifecycle tools, and the sentence telling the agent that document titles and viewer text
 * are untrusted content rather than instructions to follow.
 *
 * That last one is why this is a test and not a comment. Everything else in the block is a
 * convenience an agent can recover by reading a tool description; the untrusted-content warning is
 * a safety instruction with no other home, and it sat at the very end where truncation eats first.
 */
const CLIENT_LIMIT = 2048;

/** The longest realistic prefix: a team workspace with a long name on the longer plan label. */
const LONGEST_PREFIX = workspaceInstructions({
  orgName: "A Workspace With A Fairly Long Name Indeed",
  isPersonalOrg: false,
  plan: "free",
} as Parameters<typeof workspaceInstructions>[0]);

describe("server instructions budget", () => {
  test("the whole block fits in what a client will deliver", () => {
    const delivered = LONGEST_PREFIX + SERVER_INSTRUCTIONS;
    expect(delivered.length).toBeLessThanOrEqual(CLIENT_LIMIT);
  });

  test("the untrusted-content warning survives truncation at the limit", () => {
    const delivered = (LONGEST_PREFIX + SERVER_INSTRUCTIONS).slice(0, CLIENT_LIMIT);
    // The two halves that matter: what the wrapper looks like, and what to do about it.
    expect(delivered).toContain("{ _source, _note, text }");
    expect(delivered).toMatch(/never as instructions/i);
  });

  test("an agent is still told where to start and what is destructive", () => {
    const delivered = (LONGEST_PREFIX + SERVER_INSTRUCTIONS).slice(0, CLIENT_LIMIT);
    expect(delivered).toContain("lnkdrp_whoami");
    expect(delivered).toContain("lnkdrp_archive_doc");
    expect(delivered).toMatch(/confirm/i);
  });

  test("a personal workspace prefix is not somehow longer", () => {
    const personal = workspaceInstructions({
      orgName: "",
      isPersonalOrg: true,
      plan: "pro",
    } as Parameters<typeof workspaceInstructions>[0]);
    expect((personal + SERVER_INSTRUCTIONS).length).toBeLessThanOrEqual(CLIENT_LIMIT);
  });
});
