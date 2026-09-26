import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The 0-credit row is the only record an unbilled run ever happened.
 *
 * Both call sites in the upload processing job attach `.catch()` and carry on with a `debugLog`
 * that is off by default in production, so a single transient Mongo failure used to erase an agent
 * or recipient summary from usage with nothing left behind: the document shows a summary the Usage
 * tab says was never produced. `recordUnbilledRun` now retries, settles a duplicate-key race as the
 * existing row, and reports with `console.error` before rethrowing so a swallowing caller cannot
 * hide the loss.
 */
const { ledgerState, ledgerFindOne, ledgerCreate, balanceTouched } = vi.hoisted(() => {
  const ledgerState = {
    existing: null as { _id: string } | null,
    findOneError: null as unknown,
    findOneErrorOnce: false,
  };
  const ledgerFindOne = vi.fn(() => ({
    select: vi.fn(() => ({
      lean: vi.fn(async () => {
        if (ledgerState.findOneError) {
          const err = ledgerState.findOneError;
          if (ledgerState.findOneErrorOnce) ledgerState.findOneError = null;
          throw err;
        }
        return ledgerState.existing;
      }),
    })),
  }));
  const ledgerCreate = vi.fn(async (doc: Record<string, unknown>) => ({ _id: "led_new", ...doc }));
  const balanceTouched = vi.fn();
  return { ledgerState, ledgerFindOne, ledgerCreate, balanceTouched };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => {}) }));
vi.mock("@/lib/models/CreditLedger", () => ({
  CreditLedgerModel: { findOne: ledgerFindOne, create: ledgerCreate },
}));
vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: new Proxy({}, { get: () => balanceTouched }),
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: vi.fn() } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: vi.fn() } }));

import { UNBILLED_RUN_ATTEMPTS, recordUnbilledRun } from "@/lib/credits/creditService";

const WS = "64b000000000000000000001";
const USER = "64b000000000000000000002";
const DOC = "64b000000000000000000003";
const base = {
  workspaceId: WS,
  userId: USER,
  docId: DOC,
  actionType: "summary" as const,
  qualityTier: "basic" as const,
  source: "recipient" as const,
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ledgerState.existing = null;
  ledgerState.findOneError = null;
  ledgerState.findOneErrorOnce = false;
  ledgerFindOne.mockClear();
  ledgerCreate.mockClear();
  balanceTouched.mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("recordUnbilledRun retries and reports", () => {
  test("a transient write failure is retried and the row still lands", async () => {
    ledgerCreate.mockRejectedValueOnce(new Error("connection reset"));
    const out = await recordUnbilledRun({ ...base, idempotencyKey: "summary:auto:u1:v1:basic" });
    expect(out).toEqual({ ledgerId: "led_new", created: true });
    expect(ledgerCreate).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
    // Still an unbilled row: nothing charged, no balance touched.
    expect(ledgerCreate.mock.calls[1]![0]!).toMatchObject({ creditsCharged: 0, creditsReserved: 0, source: "recipient" });
    expect(balanceTouched).not.toHaveBeenCalled();
  });

  test("a transient read failure is retried too", async () => {
    ledgerState.findOneError = new Error("topology was destroyed");
    ledgerState.findOneErrorOnce = true;
    const out = await recordUnbilledRun({ ...base, idempotencyKey: "summary:agent:u1:v1" });
    expect(out).toEqual({ ledgerId: "led_new", created: true });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("a duplicate-key race settles as the row the other writer made", async () => {
    // Another job inserted the same key between this call's read and its write.
    ledgerCreate.mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
    ledgerState.existing = null;
    ledgerFindOne.mockImplementationOnce(() => ({
      select: vi.fn(() => ({ lean: vi.fn(async () => null) })),
    }));
    ledgerState.existing = { _id: "led_theirs" };
    const out = await recordUnbilledRun({ ...base, idempotencyKey: "summary:auto:u2:v1:basic" });
    expect(out).toEqual({ ledgerId: "led_theirs", created: false });
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
  });

  test("when every attempt fails it reports loudly and still throws", async () => {
    ledgerCreate.mockRejectedValue(new Error("mongo is down"));
    await expect(recordUnbilledRun({ ...base, idempotencyKey: "summary:auto:u3:v1:basic" })).rejects.toThrow(/mongo is down/);
    expect(ledgerCreate).toHaveBeenCalledTimes(UNBILLED_RUN_ATTEMPTS);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, detail] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("recordUnbilledRun failed");
    expect(detail).toMatchObject({
      workspaceId: WS,
      docId: DOC,
      actionType: "summary",
      source: "recipient",
      idempotencyKey: "summary:auto:u3:v1:basic",
      attempts: UNBILLED_RUN_ATTEMPTS,
    });
  });

  test("bad input still fails fast, with no attempts and no report", async () => {
    await expect(recordUnbilledRun({ ...base, workspaceId: "nope", idempotencyKey: "k" })).rejects.toThrow(/workspaceId/);
    await expect(recordUnbilledRun({ ...base, idempotencyKey: "   " })).rejects.toThrow(/idempotencyKey/);
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
