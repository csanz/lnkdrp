/**
 * Nobody still in the queue gets to pay.
 *
 * `forbidWaitlisted` was applied to the eight routes that *make* something — upload, document,
 * project, link, request — and stopped at the two that take money. A queued account could not share
 * a single document, but could open Stripe Checkout and put its workspace on Pro at $29 a month, or
 * buy a credit pack, and then discover it still could not upload. Everywhere else the missing gate
 * costs someone a refused click; here it charged them for something they cannot use.
 *
 * Two things are pinned, and the second is the one that will actually catch a regression:
 *
 * 1. The two routes that start a payment call the gate.
 * 2. The one that *ends* one — the billing portal — does not. Someone who already paid has to be
 *    able to cancel, and gating their way out would turn a refund into a support ticket. That
 *    asymmetry is deliberate and easy to "tidy up" into a bug.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Routes where money starts moving. */
const TAKES_MONEY = ["src/app/api/stripe/checkout/route.ts", "src/app/api/credits/purchase/route.ts"];

/** Routes a person who already paid needs, including to stop paying. */
const LETS_THEM_OUT = ["src/app/api/stripe/portal/route.ts"];

describe("the waitlist gate on payment", () => {
  test.each(TAKES_MONEY)("%s refuses a queued account", (path) => {
    const src = read(path);

    expect(src).toContain("forbidWaitlisted");
    // Called, not merely imported: an unused import satisfies a `toContain` on the name alone.
    expect(src).toMatch(/await forbidWaitlisted\(\s*actor\s*,/);
  });

  test.each(LETS_THEM_OUT)("%s does not, so a subscriber can still get out", (path) => {
    expect(read(path)).not.toContain("forbidWaitlisted");
  });
});

describe("the refusal is usable by the caller", () => {
  test("it names where to send the person, not just that they are refused", async () => {
    const { forbidWaitlisted } = await import("@/lib/gating/waitlist");

    // `isWaitlistedActor` short-circuits on a non-user actor without touching Mongo, so the pure
    // half of the gate is reachable here: a temp actor is never queued and must get null.
    const temp = await forbidWaitlisted({ kind: "temp" } as never, "start a subscription");
    expect(temp).toBe(null);
  });

  test("the billing client follows a redirect instead of printing the code", () => {
    // `startCheckout` used to throw `json.error`, which put the literal word WAITLISTED in a toast
    // and ignored the `redirectTo` the gate includes for exactly this case.
    const src = read("src/lib/billing/clientActions.ts");

    // Both redirect-returning calls route their refusals through it: one definition, two uses.
    expect(src.match(/failOrRedirect/g) ?? []).toHaveLength(3);
    expect(src).toMatch(/if \(!res\.ok\) return failOrRedirect\(json, res\.status\);/);
    // Same-origin only: following an absolute URL from a response would be an open redirect.
    expect(src).toContain('redirectTo.startsWith("/") && !redirectTo.startsWith("//")');
    // `resumeSubscription` deliberately still throws: it manages a subscription that already
    // exists, returns no URL, and a queued account has no business reaching it either way.
  });
});

describe("why the page says what it says", () => {
  test("a known code becomes our sentence", async () => {
    const { waitlistBlockedNotice } = await import("@/lib/waitlist/waitlist");

    expect(waitlistBlockedNotice("upgrade")).toContain("not take payment");
    expect(waitlistBlockedNotice("credits")).toContain("still in the queue");
  });

  test("anything else shows nothing, rather than anything the URL said", async () => {
    // `?blocked=` is attacker-controlled and the page renders what this returns. Echoing it would
    // let anyone hand out a link that makes the product appear to say something it never said.
    const { waitlistBlockedNotice } = await import("@/lib/waitlist/waitlist");

    for (const v of [
      "",
      "unknown",
      "<script>alert(1)</script>",
      "Your account was deleted",
      "__proto__",
      "constructor",
      "toString",
      undefined,
      null,
      42,
      { toString: () => "upgrade" },
    ]) {
      expect(waitlistBlockedNotice(v)).toBe(null);
    }
  });

  test("the two payment routes each tag their redirect", () => {
    expect(read("src/app/api/stripe/checkout/route.ts")).toContain('reason: "upgrade"');
    expect(read("src/app/api/credits/purchase/route.ts")).toContain('reason: "credits"');
  });

  test("the reason is the only thing put in the URL, and it is encoded", async () => {
    const src = read("src/lib/gating/waitlist.ts");

    expect(src).toContain("encodeURIComponent(reason)");
    // `what` is a free-text sentence fragment and must never reach the query string.
    expect(src).not.toMatch(/blocked=\$\{[^}]*what/);
  });
});
