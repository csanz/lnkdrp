/**
 * What a forced review is allowed to charge, who is allowed to start one, and how many model calls
 * one charge may buy.
 *
 * `POST /api/uploads/:uploadId/process?forceReview=1` is the "Rerun review" button. It costs 2, 5
 * or 12 credits depending on tier, and it runs entirely inside `after()` - the response has already
 * gone by the time anything is reserved. Three defects came out of that shape:
 *
 * - **The settle refunded only a `failed` Review row.** `failed` is one of three ways a run ends
 *   with nothing to read. The model returning null (no API key configured, or both attempts threw)
 *   writes `skipped`; agent output that parses with an empty summary writes `completed` carrying no
 *   markdown. Both were charged in full, and the owner was left 5 credits down looking at a blank
 *   review with a "Rerun review" button they had already paid for once.
 *
 * - **The preflight asked only `snap.blocked`.** That is the hard stop, not affordability, so a
 *   workspace holding 1 credit got a 200 for a 5-credit review and the shortfall surfaced as a
 *   throw inside background work that nothing renders: the page sat on a spinner. The sibling
 *   summary route (`/api/uploads/:uploadId/summary`) already asks the question the right way round.
 *
 * - **One reservation could buy two model calls.** Reservations are idempotent on their key and
 *   `x-idempotency-key` lets the caller choose it, so two concurrent forceReview requests carrying
 *   the same key got the same *pending* row back. The route refused only a `charged` replay, so
 *   both believed they had reserved and both called the model. There was no upload claim to fall
 *   back on either: a completed upload is never claimed.
 *
 * The shipped expressions are evaluated out of the route source, the way
 * `processCompareCredits.test.ts` and `recipientProcessGuards.test.ts` do: the bugs were in those
 * lines, so those lines are what run here.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { creditsForRun } from "@/lib/credits/schedule";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";

const source = fs.readFileSync(path.join(REPO_ROOT, PROCESS_ROUTE), "utf8");

/** Every `const <name> = <expr>;` in the route, compiled so the real expression runs. */
function expressions(name: string, params: string[]): Array<(...args: any[]) => any> {
  const found = [...source.matchAll(new RegExp(`const ${name} =([\\s\\S]*?);\\n`, "g"))].map((m) => m[1]!);
  expect(found.length, `the route still decides in \`const ${name} = ...\``).toBeGreaterThan(0);
  return found.map((expr) => new Function(...params, `return (${expr});`) as (...args: any[]) => any);
}

// --- 1. a review is charged for output, not for the absence of a crash ----------------------------

describe("a review that produced nothing is refunded", () => {
  /** Both settles (legacy agent and request-review agent) decide with the same expression. */
  const settles = () => expressions("reviewProducedOutput", ["outcomeStatus", "outcomeMarkdown"]);

  test("both review branches settle the same way", () => {
    expect(settles()).toHaveLength(2);
  });

  test("a failed run is refunded (it always was)", () => {
    for (const producedOutput of settles()) expect(producedOutput("failed", "")).toBe(false);
  });

  test("a skipped run is refunded", () => {
    // Written when the model returns null: no `OPENAI_API_KEY`, or both attempts threw. Not a
    // failure, not an output, and charged in full until now.
    for (const producedOutput of settles()) expect(producedOutput("skipped", "")).toBe(false);
  });

  test("output that parsed with an empty summary is refunded", () => {
    // `runRequestReviewInvestorFocused` writes `completed` with null markdown when
    // `summary_markdown` comes back empty. The row says completed; the page is blank.
    for (const producedOutput of settles()) expect(producedOutput("completed", "")).toBe(false);
    // Whitespace-only markdown is the same blank page: the route trims before asking.
    const trims = [...source.matchAll(/const outcomeMarkdown = String\(\(outcome as \{ outputMarkdown\?: unknown \} \| null\)\?\.outputMarkdown \?\? ""\)\.trim\(\);/g)];
    expect(trims).toHaveLength(2);
  });

  test("a review with markdown is charged", () => {
    for (const producedOutput of settles()) {
      expect(producedOutput("completed", "## Strengths\n- clear ask")).toBe(true);
    }
  });

  test("the settle reads the markdown, so it has to be selected", () => {
    // The row was fetched with `.select({ status: 1 })`, which is why only the status could be
    // asked about.
    const selects = [...source.matchAll(/\.select\(\{ status: 1, outputMarkdown: 1 \}\)/g)];
    expect(selects).toHaveLength(2);
  });

  test("the refund is the branch taken when there is no output", () => {
    const refunds = [...source.matchAll(/if \(!reviewProducedOutput\) \{\s*\n\s*await failAndRefundLedger\(/g)];
    expect(refunds).toHaveLength(2);
  });
});

// --- 2. the preflight refuses a review the workspace cannot pay for -------------------------------

describe("the forced-review preflight checks affordability", () => {
  const cannotAfford = () => expressions("cannotAffordReview", ["snap", "forceReviewCreditsNeeded"])[0]!;

  const standard = creditsForRun({ actionType: "review", qualityTier: "standard" });
  const advanced = creditsForRun({ actionType: "review", qualityTier: "advanced" });

  test("a blocked workspace is refused (it always was)", () => {
    expect(cannotAfford()({ blocked: true, spendableRemaining: 100, creditsRemaining: 100 }, standard)).toBe(true);
  });

  test("a workspace short of the price is refused before the work is queued", () => {
    // The defect: 200 OK, then a throw inside `after()` that no user ever sees.
    expect(cannotAfford()({ blocked: false, spendableRemaining: 1, creditsRemaining: 1 }, standard)).toBe(true);
    expect(cannotAfford()({ blocked: false, spendableRemaining: 0, creditsRemaining: 0 }, standard)).toBe(true);
    // Advanced costs more, so a balance that affords Standard can still be short for it.
    expect(cannotAfford()({ blocked: false, spendableRemaining: standard, creditsRemaining: standard }, advanced)).toBe(true);
  });

  test("a workspace that can pay is let through", () => {
    expect(cannotAfford()({ blocked: false, spendableRemaining: standard, creditsRemaining: standard }, standard)).toBe(false);
    expect(cannotAfford()({ blocked: false, spendableRemaining: 500, creditsRemaining: 500 }, advanced)).toBe(false);
  });

  test("Pro with uncapped on-demand is never refused on a number", () => {
    // `spendableRemaining` is null there: the run may legitimately go past the credits held.
    expect(cannotAfford()({ blocked: false, spendableRemaining: null, creditsRemaining: 0 }, advanced)).toBe(false);
  });

  test("the 402 says what it needed, like the summary route's does", () => {
    const at = source.indexOf("const cannotAffordReview");
    const body = source.slice(at, at + 900);
    expect(body).toContain("creditsNeeded: forceReviewCreditsNeeded");
    expect(body).toContain("creditsRemaining: snap.creditsRemaining");
    expect(body).toContain("OUT_OF_CREDITS_CODE");
  });
});

// --- 3. one charge, one model call ----------------------------------------------------------------

describe("two concurrent forced reviews cannot share one charge", () => {
  /** The `$or` a claim is taken under, pulled out of `claimReviewRun` and evaluated. */
  function claimClauses(staleBefore: Date): Array<Record<string, any>> {
    const m = source.match(/const unclaimedOrStale = (\[[\s\S]*?\]);\n/);
    expect(m?.[1], "the claim still decides in `const unclaimedOrStale = [...]`").toBeTruthy();
    return new Function("staleBefore", `return ${m![1]};`)(staleBefore);
  }

  /** Enough of Mongo's matcher to run that `$or`: `$ne`, `$lt`, and `null` meaning "missing too". */
  function matches(row: Record<string, unknown>, clauses: Array<Record<string, any>>): boolean {
    return clauses.some((clause) =>
      Object.entries(clause).every(([field, cond]) => {
        const value = row[field];
        if (cond && typeof cond === "object" && !(cond instanceof Date)) {
          if ("$ne" in cond) return value !== cond.$ne;
          if ("$lt" in cond) return value instanceof Date && value.getTime() < (cond.$lt as Date).getTime();
        }
        if (cond === null) return value === null || value === undefined;
        return value === cond;
      }),
    );
  }

  const now = Date.now();
  const staleBefore = new Date(now - 5 * 60 * 1000);

  test("a review somebody is already running cannot be claimed", () => {
    // The second of two concurrent callers. Before the claim existed, it reserved (getting the
    // first caller's pending row back), saw `pending`, and called the model on the same charge.
    const clauses = claimClauses(staleBefore);
    expect(matches({ status: "processing", updatedDate: new Date(now - 1_000) }, clauses)).toBe(false);
  });

  test("a review nobody is running can be claimed", () => {
    const clauses = claimClauses(staleBefore);
    for (const status of ["queued", "completed", "failed", "skipped"]) {
      expect(matches({ status, updatedDate: new Date(now - 1_000) }, clauses)).toBe(true);
    }
  });

  test("a claim whose holder died is taken over", () => {
    // Otherwise a crashed run would lock the version out of reruns for good.
    const clauses = claimClauses(staleBefore);
    expect(matches({ status: "processing", updatedDate: new Date(now - 60 * 60 * 1000) }, clauses)).toBe(true);
    // A legacy row with no `updatedDate` at all is not evidence that anyone is running it.
    expect(matches({ status: "processing" }, clauses)).toBe(true);
  });

  test("the claim is taken before the credits are reserved, in both review branches", () => {
    // Order matters: reserving first is what let both callers believe they had paid for the run.
    const claims = [...source.matchAll(/const reviewClaim = await claimReviewRun\(/g)].map((m) => m.index!);
    const reserves = [...source.matchAll(/const reserved = await reserveForAttempt\(\{\s*\n\s*workspaceId: actor\.orgId,\s*\n\s*userId: actor\.userId,\s*\n\s*docId: String\(docId\),\s*\n\s*actionType: "review"/g)].map(
      (m) => m.index!,
    );
    expect(claims).toHaveLength(2);
    expect(reserves).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) expect(claims[i]!).toBeLessThan(reserves[i]!);
  });

  test("the loser of the claim runs nothing and spends nothing", () => {
    const bails = [...source.matchAll(/if \(!reviewClaim\) \{/g)];
    expect(bails).toHaveLength(2);
  });

  test("a caller that bails puts the row back", () => {
    // Both bail paths: the reservation replayed as already `charged`, and the reservation threw
    // (out of credits). Without the release the row would sit in `processing` and the review UI
    // polls that status for ever.
    const releases = [...source.matchAll(/await releaseReviewRun\(/g)];
    expect(releases.length).toBeGreaterThanOrEqual(4);
  });

  test("the run keeps its claim through the review itself", () => {
    // `ensureReviewForUpload(force: true)` reset the row to `queued` and then re-locked it; in that
    // gap a second caller could take the claim and make the second paid call anyway.
    expect(source).toContain("claimed: true");
    expect([...source.matchAll(/claimed: true/g)]).toHaveLength(2);
    expect(source).toContain('$set: { status: holdsClaim ? "processing" : "queued" }');
  });
});

// --- 4. the free paths are still free -------------------------------------------------------------

describe("the deliberate free paths are unchanged", () => {
  test("an agent-written summary costs nothing", () => {
    // `agentSummary` keeps the run out of `summaryWanted` entirely, so nothing is reserved, and the
    // run is recorded as a 0-credit ledger row instead.
    const wanted = source.match(/const summaryWanted =([\s\S]*?);\n/)?.[1] ?? "";
    expect(wanted).toContain("!agentSummary");
    expect(source).toContain('source: "agent",');
    expect(source).toContain("recordUnbilledRun({");
  });

  test("a recipient upload never spends the owner's credits", () => {
    // The summary reserve is gated on it, and both compare gates refuse it.
    expect(source).toContain("if (summaryWanted && !viaUploadSecret) {");
    for (const expr of [...source.matchAll(/const historyAllowed =([^;]*);/g)].map((m) => m[1]!)) {
      expect(expr).toContain("!viaUploadSecret");
    }
    expect(source).toContain('const forceReview = forceReviewRequested && !viaUploadSecret');
  });

  test("a forced review is never started for a secret caller", () => {
    // The rerun button is an owner action; an upload secret is a capability in a URL.
    const m = source.match(/const forceReview = ([^;]*);/);
    const forceReview = new Function("forceReviewRequested", "viaUploadSecret", "actor", "authConfigured", `return Boolean(${m![1]});`);
    expect(forceReview(true, true, { kind: "user" }, true)).toBe(false);
    expect(forceReview(true, false, { kind: "user" }, true)).toBe(true);
  });
});
