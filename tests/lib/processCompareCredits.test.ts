/**
 * The replacement compare: whether it runs at all, and what it is allowed to charge.
 *
 * `POST /api/uploads/:uploadId/process` holds two near-identical compare blocks. The lower one is
 * the real replacement path (an upload claimed `uploaded -> processing`); the upper one is a
 * backfill that only fires when an upload finished `completed` without a DocChange. They drifted,
 * and each drift cost the owner money in a different direction:
 *
 * - **"Compare every replacement" was read in the backfill only.** The dashboard card and the
 *   welcome flow both sell that switch as governing exactly this run, and the sibling summary gate
 *   in the same block honoured its own flag — so a workspace with the compare switched off was
 *   still billed 5 credits per replacement (12 on Advanced) and the toggle looked broken rather
 *   than unimplemented.
 *
 * - **The backfill reserved with a raw `reserveCreditsOrThrow`.** Reservations are idempotent on
 *   their key, so it handed back the earlier attempt's finished row: a `failed` one whose credits
 *   had already been refunded (the model then ran again and the row flipped to `charged`, so the
 *   usage aggregates rose while the balance did not move), or a `charged` one (a second compare for
 *   free). Every other reserve in the file goes through `reserveForAttempt` and checks the status.
 *
 * - **Both settles recomputed the price.** The compare's idempotency key deliberately carries no
 *   tier, so a retried attempt after the owner moved the workspace default — or after a Free -> Pro
 *   upgrade — replays a reservation taken at the old price. Marking it charged at the new one wrote
 *   a ledger row the balance never matched, and `usedThisCycle` and `creditsRemaining` drift apart
 *   permanently.
 *
 * The gate is asserted by evaluating the shipped expression out of the route source, the way
 * `recipientProcessGuards.test.ts` does: the bug was in that one line, so that one line is what
 * runs here rather than a paraphrase of it.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCreditService } from "@/lib/credits/serviceCore";
import { creditsForRun } from "@/lib/credits/schedule";
import type { CreditStore, WorkspaceBalanceSnapshot } from "@/lib/credits/store";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";

const source = fs.readFileSync(path.join(REPO_ROOT, PROCESS_ROUTE), "utf8");

// --- 1. the switch actually gates the replacement path -------------------------------------------

describe("the compare gate honours the workspace switch", () => {
  /** Every `const historyAllowed = <expr>;` in the route, compiled so the real expression runs. */
  function gates(): Array<(viaUploadSecret: boolean, nothingChanged: boolean, automationCompareOn: boolean) => boolean> {
    const matches = [...source.matchAll(/const historyAllowed =([^;]*);/g)].map((m) => m[1]!);
    expect(matches.length, "the route still decides in `const historyAllowed = ...`").toBeGreaterThan(0);
    return matches.map(
      (expr) =>
        new Function("viaUploadSecret", "nothingChanged", "automationCompareOn", `return Boolean(${expr});`) as (
          a: boolean,
          b: boolean,
          c: boolean,
        ) => boolean,
    );
  }

  test("both compare blocks read the flag, not just the backfill", () => {
    // The whole defect: one of the two was edited in the belief that it was the replacement path.
    const matches = [...source.matchAll(/const historyAllowed =([^;]*);/g)].map((m) => m[1]!);
    expect(matches).toHaveLength(2);
    for (const expr of matches) expect(expr).toContain("automationCompareOn");
  });

  test("off means no run, on an ordinary replacement with changed text", () => {
    for (const gate of gates()) {
      expect(gate(false, false, false)).toBe(false);
    }
  });

  test("on is still the normal case", () => {
    // The flag defaults on and reads on when absent, so the ordinary replacement must be unaffected.
    for (const gate of gates()) {
      expect(gate(false, false, true)).toBe(true);
    }
  });

  test("the reasons already in the gate still hold with the flag on", () => {
    // A recipient upload never spends the owner's credits; an identical re-upload has nothing to
    // compare. The replacement path knows both; the backfill has no notion of `nothingChanged`.
    const replacement = gates()[1]!;
    expect(replacement(true, false, true)).toBe(false);
    expect(replacement(false, true, true)).toBe(false);
    expect(gates()[0]!(true, false, true)).toBe(false);
  });

  test("a skipped compare is named, so the empty version history is not read as a failure", () => {
    expect(source).toContain('aiState.reason = aiState.reason ?? "automatic compares are turned off for this workspace"');
    expect(source).toContain('aiState.code = aiState.code ?? "turned_off"');
  });
});

// --- 2. the backfill reserves like everywhere else ------------------------------------------------

describe("the completed-upload backfill reserves through reserveForAttempt", () => {
  test("nothing in the route body reserves raw", () => {
    // `reserveForAttempt` is the only thing allowed to call it: a raw reserve returns a finished row
    // (refunded, or already paid) with no status filter, and the caller then charges or re-runs it.
    const helperEnd = source.indexOf("const PROCESSING_STALE_MS");
    expect(helperEnd).toBeGreaterThan(0);
    const calls = [...source.matchAll(/await reserveCreditsOrThrow\(/g)].map((m) => m.index!);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) expect(at).toBeLessThan(helperEnd);
  });

  test("an already-charged version is not compared a second time for free", () => {
    const backfill = source.slice(
      source.indexOf("history:auto:${String(docId)}:to:${toVersion}"),
      source.indexOf("let diff = null as any;"),
    );
    expect(backfill).toContain("await reserveForAttempt(");
    expect(backfill).toContain('reserved.status === "charged"');
  });
});

// --- 3. what a settle is allowed to charge --------------------------------------------------------

describe("every settle charges what the reservation actually took", () => {
  test("no settle recomputes the price from today's tier", () => {
    const charged = [...source.matchAll(/creditsCharged: (\w+)/g)].map((m) => m[1]!);
    expect(charged.length).toBeGreaterThan(0);
    // `historyCredits` / `reviewCredits` are this attempt's price; the reservation may be older.
    expect(charged).not.toContain("historyCredits");
    expect(charged).not.toContain("reviewCredits");
  });

  test("the charged amount comes off the reservation, at both compare blocks", () => {
    const assignments = [...source.matchAll(/historyChargedCredits = reserved\.creditsReserved;/g)];
    expect(assignments).toHaveLength(2);
    expect(source).not.toContain("creditsUsedThisRun += historyCredits;");
  });

  test("the review settles do the same: a caller-supplied idempotency key can replay a tier", () => {
    const assignments = [...source.matchAll(/reviewChargedCredits = reserved\.creditsReserved;/g)];
    expect(assignments).toHaveLength(2);
    expect(source).not.toContain("creditsUsedThisRun += reviewCredits;");
  });
});

// --- 4. why that matters: a replay hands back the old price ----------------------------------------

/** The smallest store the credit service will run against: enough to watch one replay. */
function makeStore(initial: WorkspaceBalanceSnapshot) {
  let balance: WorkspaceBalanceSnapshot = { ...initial };
  const byKey = new Map<string, string>();
  const rows = new Map<string, { id: string; status: string; creditsReserved: number; creditsEstimated: number; creditsCharged: number; creditsFrom: Record<string, number>; workspaceId: string; userId: string; docId: string | null; actionType: string; qualityTier: string }>();
  let nextId = 1;

  const store: CreditStore = {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return await fn();
    },
    async getLedgerByIdempotencyKey({ idempotencyKey }) {
      const id = byKey.get(idempotencyKey);
      return id ? ({ ...rows.get(id)! } as any) : null;
    },
    async createPendingLedger(args) {
      const id = String(nextId++);
      byKey.set(args.idempotencyKey, id);
      rows.set(id, {
        id,
        status: "pending",
        creditsReserved: args.creditsReserved,
        creditsEstimated: args.creditsEstimated,
        creditsCharged: 0,
        creditsFrom: args.creditsFrom as any,
        workspaceId: args.workspaceId,
        userId: args.userId,
        docId: args.docId,
        actionType: args.actionType as any,
        qualityTier: args.qualityTier as any,
      });
      return { id };
    },
    async getOrCreateBalance() {
      return { ...balance };
    },
    async saveBalance({ next }) {
      balance = { ...next };
    },
    async getUsageSums() {
      return { dailyReserved: 0, monthlyReserved: 0, monthlyOnDemandReserved: 0 };
    },
    async getLedgerById({ ledgerId }) {
      const v = rows.get(ledgerId);
      return v ? ({ ...v } as any) : null;
    },
    async setLedgerStatus({ ledgerId, status, creditsCharged }) {
      const v = rows.get(ledgerId);
      if (!v) return;
      v.status = status;
      if (typeof creditsCharged === "number") v.creditsCharged = creditsCharged;
    },
  };

  return { store, getBalance: () => balance, getRow: (id: string) => rows.get(id)! };
}

describe("a replayed reservation still holds the old price", () => {
  test("reserving at standard and replaying at advanced returns 5, not 12", async () => {
    const { store, getBalance, getRow } = makeStore({
      trialCreditsRemaining: 0,
      subscriptionCreditsRemaining: 100,
      purchasedCreditsRemaining: 0,
      onDemandEnabled: false,
      onDemandMonthlyLimitCents: 0,
      dailyCreditCap: null,
      monthlyCreditCap: null,
      perRunCreditCapBasic: 20,
      perRunCreditCapStandard: 60,
      perRunCreditCapAdvanced: 150,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    const svc = createCreditService(store);
    const common = {
      workspaceId: "w1",
      userId: "u1",
      docId: "d1",
      actionType: "history" as const,
      // The compare key carries no tier on purpose, so that moving the default cannot bill the same
      // version twice. The cost of that choice is exactly this: the replay below is the same row.
      idempotencyKey: "history:auto:d1:to:2",
      initBalanceIfMissing: async () => getBalance(),
    };

    const first = await svc.reserveCreditsOrThrow({ ...common, qualityTier: "standard" });
    expect(first.creditsReserved).toBe(creditsForRun({ actionType: "history", qualityTier: "standard" }));
    expect(getBalance().subscriptionCreditsRemaining).toBe(95);

    const replay = await svc.reserveCreditsOrThrow({ ...common, qualityTier: "advanced" });
    expect(replay.ledgerId).toBe(first.ledgerId);
    expect(replay.status).toBe("pending");
    // Nothing more left the balance, so 5 is the only number a settle can honestly write.
    expect(replay.creditsReserved).toBe(5);
    expect(getBalance().subscriptionCreditsRemaining).toBe(95);

    await svc.markLedgerCharged({ ledgerId: replay.ledgerId, creditsCharged: replay.creditsReserved });
    const row = getRow(replay.ledgerId);
    expect(row.creditsCharged).toBe(5);
    // The row and the balance agree: 100 - 95 spent, 5 charged. Settling at `creditsForRun` for the
    // new tier would have written 12 here and left the two permanently out of step.
    expect(row.creditsCharged).toBe(100 - getBalance().subscriptionCreditsRemaining);
  });
});
