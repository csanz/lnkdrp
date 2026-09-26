/**
 * The manual AI-compare rerun: what a replayed idempotency key may do, what a settle may charge,
 * and what a compare that found nothing costs.
 *
 * `POST /api/docs/:docId/changes/:changeId/rerun` is the paid "Regenerate" button on the version
 * history page. It took the caller's `x-idempotency-key` verbatim, handed it to
 * `reserveCreditsOrThrow` and never looked at `reserved.status`. Three things followed:
 *
 * - **A replay ran the model again for free.** Reservations are idempotent on their key, so the
 *   second call got the first call's finished row back - `charged`, its credits already taken -
 *   and the route went straight on to run the compare and mark the same row charged a second time.
 *   Every balance and daily-cap check lives *after* that short-circuit in `serviceCore`, so a
 *   workspace with a zero balance could keep replaying. Because the key was the caller's own
 *   string, an API key or agent could also send `history:auto:<docId>:to:<n>` - the automatic
 *   compare's key - and settle on a row the workspace had already paid for.
 *
 * - **The settle recomputed the price from this request's tier.** A row reserved at 2 could be
 *   marked charged at 12: credits the balance never gave up, and `usedThisCycle` and
 *   `creditsRemaining` drift apart permanently.
 *
 * - **A no-change rerun was charged in full.** `runDocChangeDiff` answers two identical versions
 *   itself, before the model and before the API-key check. The automatic path treats that outcome
 *   as free (it never reserves); the rerun button charged 2, 5 or 12 credits for it.
 *
 * - **Then the refund for it was keyed on the summary text, which let it run free.** The first fix
 *   refunded whenever the result carried the no-change sentence, and `runDocChangeDiff` produces
 *   that sentence from two places: its free pre-model short-circuit, and again *after*
 *   `generateObject` has run and been paid for, because the compare prompt instructs the model to
 *   answer with exactly that sentence when it finds no real content difference. So a real OpenAI
 *   call cost the workspace nothing, and because the cap sums count only `pending` and `charged`
 *   rows, the refunded reservation was invisible to the daily and monthly caps too - with a fresh
 *   key per press, unbounded free AI spend. Free is now decided *before* reserving, from the text
 *   itself, and the only thing that can free a reservation afterwards is "the model never ran".
 *
 * The credit service here is the real `createCreditService` over an in-memory store, so the
 * balance numbers below are the ones a workspace would actually see.
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

import { NO_CHANGE_SUMMARY } from "@/lib/ai/docChangeSummary";

// --- the credit ledger, in memory ----------------------------------------------------------------

const C = vi.hoisted(() => {
  const emptyBalance = () => ({
    trialCreditsRemaining: 0,
    subscriptionCreditsRemaining: 0,
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

  const s = {
    balance: emptyBalance() as Record<string, unknown>,
    rows: new Map<string, Record<string, unknown>>(),
    byKey: new Map<string, string>(),
    nextId: 1,
    /** Force the next key lookup to resolve to this row, whatever key is asked for. */
    pinnedLookup: null as string | null,
    charges: [] as Array<{ ledgerId: string; creditsCharged: number }>,
    refunds: [] as string[],
    keysSeen: [] as string[],
    reset(credits: number) {
      s.balance = { ...emptyBalance(), subscriptionCreditsRemaining: credits };
      s.rows.clear();
      s.byKey.clear();
      s.nextId = 1;
      s.pinnedLookup = null;
      s.charges.length = 0;
      s.refunds.length = 0;
      s.keysSeen.length = 0;
    },
    setCredits(credits: number) {
      (s.balance as Record<string, unknown>).subscriptionCreditsRemaining = credits;
    },
    get spendable(): number {
      return Number((s.balance as Record<string, number>).subscriptionCreditsRemaining);
    },
  };

  const store = {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return await fn();
    },
    async getLedgerByIdempotencyKey({ idempotencyKey }: { idempotencyKey: string }) {
      s.keysSeen.push(idempotencyKey);
      if (s.pinnedLookup) return { ...s.rows.get(s.pinnedLookup)! };
      const id = s.byKey.get(idempotencyKey);
      return id ? { ...s.rows.get(id)! } : null;
    },
    async createPendingLedger(args: Record<string, unknown>) {
      const id = String(s.nextId++);
      s.byKey.set(String(args.idempotencyKey), id);
      s.rows.set(id, {
        id,
        status: "pending",
        creditsReserved: args.creditsReserved,
        creditsEstimated: args.creditsEstimated,
        creditsCharged: 0,
        creditsFrom: args.creditsFrom,
        workspaceId: args.workspaceId,
        userId: args.userId,
        docId: args.docId,
        actionType: args.actionType,
        qualityTier: args.qualityTier,
        idempotencyKey: args.idempotencyKey,
      });
      return { id };
    },
    async getOrCreateBalance() {
      return { ...s.balance };
    },
    async saveBalance({ next }: { next: Record<string, unknown> }) {
      s.balance = { ...next };
    },
    async getUsageSums() {
      return { dailyReserved: 0, monthlyReserved: 0, monthlyOnDemandReserved: 0 };
    },
    async getLedgerById({ ledgerId }: { ledgerId: string }) {
      const v = s.rows.get(ledgerId);
      return v ? { ...v } : null;
    },
    async setLedgerStatus({
      ledgerId,
      status,
      creditsCharged,
    }: {
      ledgerId: string;
      status: string;
      creditsCharged?: number;
    }) {
      const v = s.rows.get(ledgerId);
      if (!v) return;
      v.status = status;
      if (typeof creditsCharged === "number") v.creditsCharged = creditsCharged;
    },
  };

  return { s, store };
});

vi.mock("@/lib/credits/creditService", async () => {
  const { createCreditService } = await import("@/lib/credits/serviceCore");
  const svc = createCreditService(C.store as never);
  return {
    reserveCreditsOrThrow: async (p: Record<string, unknown>) =>
      await (svc.reserveCreditsOrThrow as (a: unknown) => Promise<unknown>)({
        ...p,
        initBalanceIfMissing: async () => ({ ...C.s.balance }),
      }),
    markLedgerCharged: async (p: { ledgerId: string; creditsCharged: number; telemetry?: unknown }) => {
      C.s.charges.push({ ledgerId: p.ledgerId, creditsCharged: p.creditsCharged });
      await svc.markLedgerCharged({ ledgerId: p.ledgerId, creditsCharged: p.creditsCharged, telemetry: null });
    },
    failAndRefundLedger: async (p: { ledgerId: string }) => {
      C.s.refunds.push(p.ledgerId);
      await svc.failAndRefundLedger({ ledgerId: p.ledgerId });
    },
  };
});

// --- everything the route touches besides credits -------------------------------------------------

const A = vi.hoisted(() => ({
  change: null as Record<string, unknown> | null,
  diffCalls: 0,
  /** What `runDocChangeDiff` answers; a function is called so a test can vary per attempt. */
  diffResult: null as unknown,
  changeUpdates: [] as unknown[],
  /**
   * Usage the fake `runDocChangeDiff` reports, i.e. "this answer came from the model".
   * `null` is the callee's pre-model short-circuit, which never calls `onUsage`.
   */
  diffUsage: null as Record<string, unknown> | null,
  /** What `loadChangedPages` hands back, and the two uploads the page counts are read from. */
  changedPages: [] as Array<Record<string, unknown>>,
  prevUpload: null as Record<string, unknown> | null,
  newUpload: null as Record<string, unknown> | null,
}));

const docId = new Types.ObjectId();
const changeId = new Types.ObjectId();
const toUploadId = new Types.ObjectId();
const orgId = new Types.ObjectId();
const userId = new Types.ObjectId();

const actor = {
  kind: "user",
  userId: String(userId),
  orgId: String(orgId),
  personalOrgId: String(orgId),
};

vi.mock("@/lib/gating/actor", () => ({
  resolveActor: vi.fn(async () => actor),
  applyTempUserHeaders: vi.fn((res: Response) => res),
}));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => {}) }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/gating/waitlist", () => ({ forbidWaitlisted: vi.fn(async () => null) }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { exists: vi.fn(async () => ({ _id: "d" })) } }));
vi.mock("@/lib/models/DocChange", () => ({
  DocChangeModel: {
    findOne: vi.fn(() => ({ select: () => ({ lean: async () => A.change }) })),
    updateOne: vi.fn(async (filter: unknown, update: unknown) => {
      A.changeUpdates.push({ filter, update });
      return {};
    }),
  },
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: vi.fn(() => ({ select: () => ({ lean: async () => A.prevUpload }) })),
    findById: vi.fn(() => ({ select: () => ({ lean: async () => A.newUpload }) })),
  },
}));
vi.mock("@/lib/history/changedPages", () => ({
  loadChangedPages: vi.fn(async () => A.changedPages),
  attachPageContext: vi.fn((diff: unknown) => diff),
}));
vi.mock("@/lib/ai/docChangeDiff", () => ({
  // The real one: the route's pre-reserve "did anything change at all" test must be the same
  // whitespace-insensitive comparison the callee's own short-circuit uses.
  normalizeForCompare: (text: string) => text.replace(/\s+/g, " ").trim(),
  runDocChangeDiff: vi.fn(async (input: { onUsage?: (u: unknown) => void }) => {
    A.diffCalls += 1;
    // Reported only when the model actually ran, exactly as `runDocChangeDiff` reports it: after
    // `generateObject` returns and before the result is shaped.
    if (A.diffUsage) input.onUsage?.(A.diffUsage);
    return typeof A.diffResult === "function" ? (A.diffResult as () => unknown)() : A.diffResult;
  }),
}));

import { POST } from "@/app/api/docs/[docId]/changes/[changeId]/rerun/route";

const REAL_DIFF = { summary: "Raise moved to $4M.", changes: [{ type: "edit", title: "Ask", detail: null }], pagesThatChanged: [] };
const NO_CHANGE_DIFF = { summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] };
/** What `onUsage` reports when the model really ran: the proof that OpenAI tokens were spent. */
const MODEL_USAGE = {
  inputTokens: 4200,
  outputTokens: 310,
  imagesAttached: 2,
  pagesAttached: 2,
  qualityTier: "standard",
  model: "gpt-5-mini",
};

/** One press of Regenerate. `key` is the caller's `x-idempotency-key`, omitted when null. */
async function rerun(opts: { key?: string | null; tier?: "basic" | "standard" | "advanced" } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers["x-idempotency-key"] = opts.key;
  const res = await POST(
    new Request(`http://localhost/api/docs/${docId}/changes/${changeId}/rerun`, {
      method: "POST",
      headers,
      body: JSON.stringify({ qualityTier: opts.tier ?? "standard" }),
    }),
    { params: Promise.resolve({ docId: String(docId), changeId: String(changeId) }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Credits actually recorded as charged across every ledger row. */
const totalCharged = () => [...C.s.rows.values()].reduce((n, r) => n + Number(r.creditsCharged ?? 0), 0);

beforeEach(() => {
  C.s.reset(100);
  A.change = {
    _id: changeId,
    docId,
    previousText: "Raising $3M seed.",
    newText: "Raising $4M seed.",
    fromVersion: 1,
    toVersion: 2,
    toUploadId,
  };
  A.diffCalls = 0;
  A.diffResult = REAL_DIFF;
  A.diffUsage = { ...MODEL_USAGE };
  A.changeUpdates.length = 0;
  A.changedPages = [];
  A.prevUpload = null;
  A.newUpload = null;
});

// --- 1. a real rerun, and a replay of it ----------------------------------------------------------

describe("a real rerun still charges once", () => {
  test("the model runs, the diff is stored, and standard costs 5", async () => {
    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(A.diffCalls).toBe(1);
    expect(C.s.spendable).toBe(95);
    expect(totalCharged()).toBe(5);
    expect(A.changeUpdates).toHaveLength(1);
    expect(JSON.stringify(A.changeUpdates[0])).toContain("Raise moved to");
  });
});

describe("a replayed idempotency key", () => {
  test("does not run the model twice and does not charge twice", async () => {
    await rerun({ key: "press-1" });
    const replay = await rerun({ key: "press-1" });

    // The whole point of an idempotency key: the second call is the same call, not a second run.
    expect(replay.status).toBe(200);
    expect(A.diffCalls).toBe(1);
    expect(totalCharged()).toBe(5);
    expect(C.s.spendable).toBe(95);
  });

  test("cannot bypass a zero balance", async () => {
    await rerun({ key: "press-1" });
    expect(C.s.spendable).toBe(95);

    // The workspace runs dry. A replay must not buy another compare with credits it does not have,
    // and it must not reach the model at all: every balance check in `serviceCore` sits behind the
    // existing-row short-circuit, so the status is the only thing standing between a spent key and
    // an unlimited supply of free compares.
    C.s.setCredits(0);
    const replay = await rerun({ key: "press-1" });

    expect(A.diffCalls).toBe(1);
    expect(totalCharged()).toBe(5);
    expect(C.s.spendable).toBe(0);
    expect(replay.status).toBe(200);
  });

  test("a fresh key with a zero balance is refused, not run", async () => {
    C.s.setCredits(0);
    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(402);
    expect(body.code).toBe("OUT_OF_CREDITS");
    expect(A.diffCalls).toBe(0);
  });
});

// --- 2. the key is the server's, not the caller's -------------------------------------------------

describe("a caller cannot forge a key that resolves to someone else's paid row", () => {
  test("the automatic compare's own key buys nothing", async () => {
    // The automatic replacement compare reserves under `history:auto:<docId>:to:<version>` and
    // settles it. Sent verbatim by an API key or an agent, that string used to land on the paid row
    // and hand back a free compare; with a zero balance it was free compares forever.
    const autoKey = `history:auto:${String(docId)}:to:2`;
    C.s.byKey.set(autoKey, "auto-row");
    C.s.rows.set("auto-row", {
      id: "auto-row",
      status: "charged",
      creditsReserved: 5,
      creditsEstimated: 5,
      creditsCharged: 5,
      creditsFrom: { trial: 0, subscription: 5, purchased: 0, on_demand: 0 },
      workspaceId: String(orgId),
      userId: String(userId),
      docId: String(docId),
      actionType: "history",
      qualityTier: "standard",
      idempotencyKey: autoKey,
    });
    C.s.setCredits(0);

    const { status } = await rerun({ key: autoKey });

    // Nothing was borrowed: the rerun asked for its own reservation, could not afford one, and
    // never reached the model.
    expect(status).toBe(402);
    expect(A.diffCalls).toBe(0);
    expect(C.s.rows.get("auto-row")!.creditsCharged).toBe(5);
  });

  test("every key the route reserves under names this document, this change and this tier", async () => {
    await rerun({ key: "press-1", tier: "advanced" });

    const keys = C.s.keysSeen;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).toContain(String(docId));
      expect(k).toContain(String(changeId));
      expect(k).toContain("advanced");
      // The caller's string is a discriminator inside that namespace, never the whole key.
      expect(k).not.toBe("press-1");
    }
  });

  test("two different presses are two runs, so Regenerate is not a one-shot button", async () => {
    // Namespacing keeps the caller's key meaningful: a new key is a new run. This is the behaviour
    // a fully derived key would have cost us - the second press would silently return the first
    // compare and the button would stop working after one use.
    await rerun({ key: "press-1" });
    await rerun({ key: "press-2" });

    expect(A.diffCalls).toBe(2);
    expect(totalCharged()).toBe(10);
    expect(C.s.spendable).toBe(90);
  });

  test("no header at all still runs, and each call is its own run", async () => {
    await rerun({ key: null });
    await rerun({ key: null });

    expect(A.diffCalls).toBe(2);
    expect(totalCharged()).toBe(10);
  });
});

// --- 3. what a settle is allowed to charge --------------------------------------------------------

describe("the settle charges what the reservation actually took", () => {
  test("a reservation of 2 settles at 2 even when the request asks for advanced", async () => {
    // Reach a reservation whose price is not this request's price. In production that is a row
    // found under the retry-suffixed key, or one taken before the credit schedule moved; here the
    // store is told to hand the row back directly, because the derived key deliberately makes the
    // collision hard to arrange from outside.
    await rerun({ key: "cheap", tier: "basic" });
    expect(C.s.spendable).toBe(98);
    const cheapRow = [...C.s.rows.values()].find((r) => r.qualityTier === "basic")!;
    cheapRow.status = "pending";
    cheapRow.creditsCharged = 0;
    C.s.charges.length = 0;
    C.s.pinnedLookup = String(cheapRow.id);

    await rerun({ key: "cheap", tier: "advanced" });

    // 2 credits left the balance, so 2 is the only number a settle can honestly write. Recomputing
    // from the request's tier wrote 12 and left the row and the balance out of step for good.
    expect(C.s.charges).toEqual([{ ledgerId: String(cheapRow.id), creditsCharged: 2 }]);
    expect(cheapRow.creditsCharged).toBe(2);
    expect(C.s.spendable).toBe(98);
  });

  test("the route never hands the settle a freshly computed price", () => {
    const source = fs.readFileSync(
      path.join(path.resolve(__dirname, "../.."), "src/app/api/docs/[docId]/changes/[changeId]/rerun/route.ts"),
      "utf8",
    );
    // Only the settle itself: the success bodies report `creditsCharged` to the client too.
    const charged = [...source.matchAll(/markLedgerCharged\(\{[\s\S]*?creditsCharged: ([\w.]+)/g)].map((m) => m[1]!);
    expect(charged).toEqual(["reserved.creditsReserved"]);
    // The price schedule is not consulted at all any more: the reservation is the only authority.
    expect(source).not.toMatch(/creditsForRun\(/);
  });
});

// --- 4. a compare that found nothing ---------------------------------------------------------------

describe("two identical versions are free, and free before anything is reserved", () => {
  /** The rerun fixture, with both sides reading the same (whitespace differences and all). */
  const identical = () => {
    A.change = { ...(A.change as Record<string, unknown>), previousText: "Raising $3M seed.", newText: "Raising  $3M   seed." };
  };

  test("never reserves, never runs the model, and costs nothing", async () => {
    // The deliberate behaviour the automatic path has always had (`nothingChanged` in the process
    // route): unchanged means no reservation at all, rather than a reserve/refund round trip. It
    // matters beyond the balance - `mongooseStore` sums only `pending` and `charged` rows, so a
    // reservation that is refunded is invisible to the daily and monthly caps, and a button that
    // reserved-then-refunded on every press could run all day without ever moving a cap.
    identical();

    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(200);
    expect(body.noChange).toBe(true);
    expect(body.creditsCharged).toBe(0);
    expect(A.diffCalls).toBe(0);
    expect(C.s.rows.size).toBe(0);
    expect(C.s.keysSeen).toEqual([]);
    expect(C.s.spendable).toBe(100);
  });

  test("still stores the record, so history reads 'no changes' rather than staying empty", async () => {
    identical();
    await rerun({ key: "press-1" });

    expect(A.changeUpdates).toHaveLength(1);
    expect(JSON.stringify(A.changeUpdates[0])).toContain(NO_CHANGE_SUMMARY);
  });

  test("a page count that moved is a real change, so it is reserved and charged", async () => {
    // `runDocChangeDiff` treats a moved page count as a change however the text compares (pages
    // appended with no extractable text change neither side of the concatenation). If the route's
    // pre-reserve test ignored that, it would answer "no changes" for a version that gained pages
    // and skip a model call the callee would have made.
    identical();
    A.prevUpload = { metadata: { pages: 13 } };
    A.newUpload = { metadata: { pages: 18 } };

    const { body } = await rerun({ key: "press-1" });

    expect(A.diffCalls).toBe(1);
    expect(body.creditsCharged).toBe(5);
    expect(totalCharged()).toBe(5);
  });

  test("same words, new artwork is a real change too", async () => {
    identical();
    A.changedPages = [{ pageNumber: 4, imageChanged: true }];

    await rerun({ key: "press-1" });

    expect(A.diffCalls).toBe(1);
    expect(totalCharged()).toBe(5);
  });
});

// --- 5. what the refund is allowed to key on ------------------------------------------------------

describe("the refund follows the model call, not the summary text", () => {
  test("a no-change summary that came back from the model is charged in full", async () => {
    // The hole this closes: `runDocChangeDiff` returns the no-change record from two places - its
    // free pre-model short-circuit, and again after `generateObject` has run and been paid for,
    // because `docChangeDiff-system.md` instructs the model to answer with that exact sentence when
    // it sees no real content difference. Refunding on the sentence refunded real OpenAI spend, and
    // since a refunded reservation is invisible to the cap sums, the spend did not show up anywhere
    // at all. Every press mints a fresh key, so this was unbounded free AI spend.
    A.diffResult = NO_CHANGE_DIFF;
    A.diffUsage = { ...MODEL_USAGE };

    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(200);
    expect(A.diffCalls).toBe(1);
    expect(body.creditsCharged).toBe(5);
    expect(body.noChange).toBe(true);
    expect(totalCharged()).toBe(5);
    expect(C.s.spendable).toBe(95);
    expect(C.s.refunds).toEqual([]);
  });

  test("pressing it repeatedly keeps costing credits, so the spend stays bounded", async () => {
    A.diffResult = NO_CHANGE_DIFF;
    A.diffUsage = { ...MODEL_USAGE };

    // A fresh key per click is what the history page actually sends (`crypto.randomUUID()`).
    await rerun({ key: "press-1" });
    await rerun({ key: "press-2" });
    await rerun({ key: "press-3" });

    expect(A.diffCalls).toBe(3);
    expect(totalCharged()).toBe(15);
    expect(C.s.spendable).toBe(85);
  });

  test("a run that never reached the model is refunded, whatever it answered", async () => {
    // The other half: the callee short-circuited after all - a condition this route did not see, or
    // one added to it later. No usage was reported, so nothing was bought and the reservation goes
    // straight back. This is the only free outcome after a reservation exists.
    A.diffResult = NO_CHANGE_DIFF;
    A.diffUsage = null;

    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.creditsCharged).toBe(0);
    expect(C.s.spendable).toBe(100);
    expect(totalCharged()).toBe(0);
    expect(C.s.refunds).toHaveLength(1);
    expect(C.s.charges).toEqual([]);

    // The record is still stored, so the history row is not left empty.
    expect(JSON.stringify(A.changeUpdates[0])).toContain(NO_CHANGE_SUMMARY);
  });

  test("a refunded row is not settled by the next press", async () => {
    // The refund leaves a row holding no credits. Settling that row on the next press would charge
    // credits the balance never gave up, so the next press must reserve again rather than reuse it.
    A.diffResult = NO_CHANGE_DIFF;
    A.diffUsage = null;
    await rerun({ key: "press-1" });
    await rerun({ key: "press-1" });

    expect(totalCharged()).toBe(0);
    expect(C.s.spendable).toBe(100);
  });

  test("a compare that did find changes is still charged in full", async () => {
    await rerun({ key: "press-1" });

    expect(C.s.refunds).toEqual([]);
    expect(totalCharged()).toBe(5);
  });

  test("the route does not decide the price from the summary at all", () => {
    const source = fs.readFileSync(
      path.join(path.resolve(__dirname, "../.."), "src/app/api/docs/[docId]/changes/[changeId]/rerun/route.ts"),
      "utf8",
    );
    // Comments out: they discuss the old summary-keyed refund by name, and the point here is what
    // the code does.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
    // `isNoChangeSummary` may still label the response for the client, but only after the settle:
    // every call site of it has to sit past `markLedgerCharged`, so it cannot decide the price.
    const settle = code.indexOf("markLedgerCharged({");
    expect(settle).toBeGreaterThan(0);
    const callSites = [...source.matchAll(/isNoChangeSummary\(/g)].map((m) => m.index!);
    expect(callSites.length).toBeGreaterThan(0);
    for (const at of callSites) expect(at).toBeGreaterThan(settle);
    // The refund after a reservation exists is keyed on "no model call", and on nothing else.
    expect(source).toMatch(/run\.usage === null[\s\S]{0,200}?failAndRefundLedger/);
  });
});

// --- 6. the failure paths that already worked -----------------------------------------------------

describe("failures still refund", () => {
  test("an unavailable compare refunds and returns 503", async () => {
    A.diffResult = null;
    const { status, body } = await rerun({ key: "press-1" });

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(C.s.spendable).toBe(100);
    expect(totalCharged()).toBe(0);
  });
});
