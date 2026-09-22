/**
 * Who still owes an acceptance of the Terms.
 *
 * The expensive mistake here is the same one `firstRun.ts` documents, and it fails in the same
 * silent, large way: `termsAcceptedAt` is null on every account that predates the field, so a naive
 * read puts an agreement screen in front of the entire existing user base — people who accepted at
 * sign-up, now told they had not. The cutoff is what separates the two populations, and these tests
 * are mostly about that boundary rather than about the happy path.
 */
import { describe, expect, test } from "vitest";

import { TERMS_GATE_SINCE, needsTermsAcceptance } from "@/lib/onboarding/termsGate";

const before = new Date(TERMS_GATE_SINCE.getTime() - 60_000);
const after = new Date(TERMS_GATE_SINCE.getTime() + 60_000);

describe("accounts that owe an acceptance", () => {
  test("a new account that has not accepted", () => {
    expect(needsTermsAcceptance({ termsAcceptedAt: null, createdAt: after })).toBe(true);
  });
});

describe("accounts that do not", () => {
  test("one that has accepted", () => {
    expect(needsTermsAcceptance({ termsAcceptedAt: new Date(), createdAt: after })).toBe(false);
  });

  test("one from before the flow existed", () => {
    // Without the cutoff this is every account in the database.
    expect(needsTermsAcceptance({ termsAcceptedAt: null, createdAt: before })).toBe(false);
  });

  test("one with no creation date at all", () => {
    // Unknown, so leave them alone: an agreement screen in front of an established workspace is
    // worse than a missed one.
    expect(needsTermsAcceptance({ termsAcceptedAt: null, createdAt: null })).toBe(false);
  });

  test("exactly on the cutoff counts as new", () => {
    expect(needsTermsAcceptance({ termsAcceptedAt: null, createdAt: TERMS_GATE_SINCE })).toBe(true);
    expect(needsTermsAcceptance({ termsAcceptedAt: null, createdAt: new Date(TERMS_GATE_SINCE.getTime() - 1) })).toBe(
      false,
    );
  });
});

describe("the gate is wired into the one place that redirects", () => {
  test("`enforceEntryGates` checks it, between the queue and first-run", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "src", "lib", "gating", "entryGate.ts"), "utf8");

    // The call expressions, not the bare names: the imports sit above the doc comment, so an
    // `indexOf` on the name alone measures the import order and passes for the wrong reason.
    const queue = src.indexOf('=== "waitlisted") redirect');
    const terms = src.indexOf("await userNeedsTermsAcceptance(userId)) redirect");
    const firstRun = src.indexOf("await userNeedsFirstRun(userId)) redirect");

    expect(queue, "queue check").toBeGreaterThan(-1);
    expect(terms, "terms check").toBeGreaterThan(-1);
    expect(firstRun, "first-run check").toBeGreaterThan(-1);
    // Nobody agrees before being let in, and nobody sets preferences before agreeing.
    expect(queue).toBeLessThan(terms);
    expect(terms).toBeLessThan(firstRun);
  });

  test("/accept works without a token, or the redirect is a lockout", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "..");

    // The page falls back to the signed-in user when there is no token...
    const page = readFileSync(join(root, "src", "app", "accept", "page.tsx"), "utf8");
    expect(page).toContain("token ? verifyAcceptToken(token)");

    // ...and the route accepts a tokenless POST from a session.
    const route = readFileSync(join(root, "src", "app", "api", "waitlist", "accept", "route.ts"), "utf8");
    expect(route).toContain("if (rawToken) {");
    // But never a session-less one.
    expect(route).toContain('return NextResponse.json({ error: "AUTH_REQUIRED"');
  });
});
