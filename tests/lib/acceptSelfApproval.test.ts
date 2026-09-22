/**
 * Accepting the Terms is not a way into the product.
 *
 * `POST /api/waitlist/accept` does two things, and only one of them is something a person may do
 * for themselves. Recording that you agree to the Terms is yours to do. Being let out of the
 * early-access queue is an admission decision that belongs to an invitation or an admin.
 *
 * The route ran both on the strength of the session alone, because the token was made optional so
 * the entry gate would not be a lockout. That reasoning was right about the Terms and wrong about
 * the approval, and the result was that anyone who could sign in with Google could leave the queue
 * with:
 *
 *     fetch("/api/waitlist/accept", { method: "POST", body: "{}" })
 *
 * No invitation, no admin, no signed token — and the resulting row was indistinguishable from a
 * real approval except that `approvedByUserId` was null. The queue is what meters paid AI
 * processing and storage, so this was the whole gate.
 *
 * Found by an adversarial review of the same day's work, independently by two reviewers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ROUTE = "src/app/api/waitlist/accept/route.ts";
const PAGE = "src/app/accept/page.tsx";

describe("approval needs an invitation, not just a session", () => {
  test("the route tracks whether a token was actually presented", () => {
    const src = read(ROUTE);

    expect(src).toMatch(/let invited = false/);
    // Set only inside the branch that has already verified the signature *and* matched the id.
    expect(src).toMatch(/invited = true/);
  });

  test("approveUser is reached only when invited", () => {
    const src = read(ROUTE);

    const guard = src.indexOf("if (invited) {");
    const approve = src.indexOf("approveUser({ userId: session.userId })");

    expect(guard, "the `if (invited)` guard").toBeGreaterThan(-1);
    expect(approve, "the approveUser call").toBeGreaterThan(-1);
    // Inside the guard, not before it. This single ordering is the fix.
    expect(guard).toBeLessThan(approve);
  });

  test("a queued account with no token is refused outright", () => {
    const src = read(ROUTE);

    // The entry gate checks the queue before the Terms, so it never sends a waitlisted person
    // here. Arriving in that state means the request came from outside the flow.
    expect(src).toMatch(/if \(!invited && \(await readAccessStatus\(session\.userId\)\) === "waitlisted"\)/);
    expect(src).toContain('error: "WAITLISTED"');
  });

  test("the Terms write is still reachable without a token", () => {
    // The tokenless path has to keep working, or the terms gate becomes a lockout for every
    // approved account that never got an invitation email.
    const src = read(ROUTE);

    const termsWrite = src.indexOf("termsAcceptedAt: new Date()");
    expect(termsWrite).toBeGreaterThan(-1);
    // Not nested inside the invited-only branch.
    expect(src.slice(src.indexOf("if (invited) {"), termsWrite)).toContain("}");
  });
});

describe("the page agrees with the route", () => {
  test("a queued account with no token is sent to the queue, not told it is in", () => {
    const src = read(PAGE);

    expect(src).toMatch(/if \(!token && \(await readAccessStatus\(verified\.userId\)\) === "waitlisted"\)/);
    expect(src).toContain('redirect("/waitlist")');
  });
});
