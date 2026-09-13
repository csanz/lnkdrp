import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Recipient uploads (request/replace links) run the automatic summary but never bill the owner:
 * `recordUnbilledRun` writes a 0-credit `source: "recipient"` ledger row, touches no balance, and
 * is idempotent on the key so a retried job does not add a second row.
 */
const { ledgerState, ledgerCreate, balanceTouched } = vi.hoisted(() => {
  const ledgerState = { existing: null as { _id: string } | null };
  const ledgerCreate = vi.fn(async (doc: Record<string, unknown>) => ({ _id: "led_new", ...doc }));
  const balanceTouched = vi.fn();
  return { ledgerState, ledgerCreate, balanceTouched };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => {}) }));
vi.mock("@/lib/models/CreditLedger", () => ({
  CreditLedgerModel: {
    findOne: vi.fn(() => ({ select: vi.fn(() => ({ lean: vi.fn(async () => ledgerState.existing) })) })),
    create: ledgerCreate,
  },
}));
vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: new Proxy({}, { get: () => balanceTouched }),
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: vi.fn() } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: vi.fn() } }));

import { recordUnbilledRun } from "@/lib/credits/creditService";

const WS = "64b000000000000000000001";
const USER = "64b000000000000000000002";
const DOC = "64b000000000000000000003";

beforeEach(() => {
  ledgerState.existing = null;
  ledgerCreate.mockClear();
  balanceTouched.mockClear();
});

describe("recordUnbilledRun", () => {
  test("writes a charged 0-credit recipient row and never touches the balance", async () => {
    const out = await recordUnbilledRun({
      workspaceId: WS,
      userId: USER,
      docId: DOC,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: "summary:auto:u1:v1:basic",
      source: "recipient",
    });
    expect(out).toEqual({ ledgerId: "led_new", created: true });
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    const row = ledgerCreate.mock.calls[0]![0]!;
    expect(row).toMatchObject({
      status: "charged",
      source: "recipient",
      actionType: "summary",
      creditsEstimated: 0,
      creditsReserved: 0,
      creditsCharged: 0,
      idempotencyKey: "summary:auto:u1:v1:basic",
    });
    expect(balanceTouched).not.toHaveBeenCalled();
  });

  test("is idempotent on the key", async () => {
    ledgerState.existing = { _id: "led_old" };
    const out = await recordUnbilledRun({
      workspaceId: WS,
      userId: USER,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: "summary:auto:u1:v1:basic",
      source: "recipient",
    });
    expect(out).toEqual({ ledgerId: "led_old", created: false });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  test("rejects malformed ids and an empty key", async () => {
    const base = { userId: USER, actionType: "summary" as const, qualityTier: "basic" as const, source: "recipient" as const };
    await expect(recordUnbilledRun({ ...base, workspaceId: "nope", idempotencyKey: "k" })).rejects.toThrow(/workspaceId/);
    await expect(recordUnbilledRun({ ...base, workspaceId: WS, idempotencyKey: "  " })).rejects.toThrow(/idempotencyKey/);
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});
