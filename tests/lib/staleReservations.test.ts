/**
 * Giving back credits held by a run that died.
 *
 * The bug this closes is quiet by construction: `reserveCreditsOrThrow` decrements the balance and
 * writes a `pending` row, the settle step flips it, and a process that dies between the two leaves
 * credits deducted from a workspace that can never spend them. The admin page reported those rows;
 * nothing returned them.
 *
 * Three properties matter more than the happy path, because each failure of them is worse than the
 * bug:
 *
 * - **It must only ever touch `ai_run` reservations.** The ledger also holds grant rows. A sweeper
 *   that selects on `status` alone would one day refund a grant, which is not returning credits but
 *   printing them.
 * - **It must not count a race as a release.** The refund is a no-op on a row that settled since
 *   the scan — correctly, that run earned its charge — and counting it anyway would report credits
 *   returned that nobody returned.
 * - **`dryRun` must write nothing.** Three credit jobs used to accept `--dry-run` and do the real
 *   work anyway, which is the single worst thing a command with "dry run" in its name can do.
 *
 * All DB access is mocked, in the style of tests/lib/orgInviteList.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const WS = "64b0c0ffee0000000000d001";
const OTHER_WS = "64b0c0ffee0000000000d002";

const { connectMongo, ledgerFind, ledgerFindById, failAndRefundLedger } = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  ledgerFind: vi.fn((_filter: Record<string, unknown>) => ({})),
  ledgerFindById: vi.fn((_id: string) => ({})),
  failAndRefundLedger: vi.fn(async (_p: { workspaceId: string; ledgerId: string }) => undefined),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/CreditLedger", () => ({
  CreditLedgerModel: { find: ledgerFind, findById: ledgerFindById },
}));
vi.mock("@/lib/credits/creditService", () => ({ failAndRefundLedger }));

const { releaseStaleReservations } = await import("@/lib/credits/staleReservations");
const { STALE_PENDING_MS } = await import("@/lib/admin/creditsAdmin");

const NOW = new Date("2026-09-22T12:00:00.000Z");

/** A pending row, `ageMinutes` old. */
function row(id: string, over: { workspaceId?: string; credits?: number; ageMinutes?: number } = {}) {
  return {
    _id: id,
    workspaceId: over.workspaceId ?? WS,
    actionType: "history",
    creditsReserved: over.credits ?? 5,
    createdDate: new Date(NOW.getTime() - (over.ageMinutes ?? 180) * 60_000),
  };
}

/** Make `find()` return these rows, and remember the filter and sort it was given. */
function findReturns(rows: unknown[]) {
  const chain = {
    sort: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    select: vi.fn(() => chain),
    lean: vi.fn(async () => rows),
  };
  ledgerFind.mockReturnValue(chain as never);
  return chain;
}

/** Make the post-release re-read report each row's status, by id. */
function statusAfter(byId: Record<string, string>) {
  ledgerFindById.mockImplementation(
    (id: string) =>
      ({
        select: () => ({ lean: async () => (byId[String(id)] ? { status: byId[String(id)] } : null) }),
      }) as never,
  );
}

beforeEach(() => {
  connectMongo.mockClear();
  ledgerFind.mockReset();
  ledgerFindById.mockReset();
  failAndRefundLedger.mockReset();
  failAndRefundLedger.mockResolvedValue(undefined);
});

describe("what it selects", () => {
  test("only unsettled AI-run reservations older than the cutoff", async () => {
    const chain = findReturns([]);

    await releaseStaleReservations({ now: NOW });

    const filter = ledgerFind.mock.calls[0]![0] as { status: string; eventType: string; createdDate: { $lt: Date } };
    expect(filter.status).toBe("pending");
    // The half that stops it refunding a grant row and printing credits.
    expect(filter.eventType).toBe("ai_run");
    expect(filter.createdDate.$lt.getTime()).toBe(NOW.getTime() - STALE_PENDING_MS);
    // Oldest first, so a backlog drains in a stable order instead of starving the worst rows.
    expect(chain.sort).toHaveBeenCalledWith({ createdDate: 1 });
  });

  test("an hour is the default, and it is the same hour the admin page calls a reservation lost", async () => {
    findReturns([]);
    const result = await releaseStaleReservations({ now: NOW });
    expect(result.olderThanMs).toBe(STALE_PENDING_MS);
    expect(STALE_PENDING_MS).toBe(60 * 60 * 1000);
  });

  test("a caller may lower the cutoff for a manual sweep", async () => {
    findReturns([]);
    await releaseStaleReservations({ now: NOW, olderThanMs: 5 * 60_000 });
    const filter = ledgerFind.mock.calls[0]![0] as { createdDate: { $lt: Date } };
    expect(filter.createdDate.$lt.getTime()).toBe(NOW.getTime() - 5 * 60_000);
  });

  test("a nonsense cutoff or limit falls back rather than sweeping everything", async () => {
    const chain = findReturns([]);
    await releaseStaleReservations({ now: NOW, olderThanMs: 0, limit: 0 });
    const filter = ledgerFind.mock.calls[0]![0] as { createdDate: { $lt: Date } };
    expect(filter.createdDate.$lt.getTime()).toBe(NOW.getTime() - STALE_PENDING_MS);
    expect(chain.limit).toHaveBeenCalledWith(500);
  });
});

describe("releasing", () => {
  test("refunds each row to its own workspace and sums what came back", async () => {
    findReturns([row("a", { credits: 5 }), row("b", { workspaceId: OTHER_WS, credits: 12 })]);
    statusAfter({ a: "failed", b: "failed" });

    const result = await releaseStaleReservations({ now: NOW });

    expect(failAndRefundLedger).toHaveBeenCalledTimes(2);
    expect(failAndRefundLedger).toHaveBeenCalledWith({ workspaceId: WS, ledgerId: "a" });
    expect(failAndRefundLedger).toHaveBeenCalledWith({ workspaceId: OTHER_WS, ledgerId: "b" });
    expect(result).toMatchObject({ scanned: 2, released: 2, creditsReturned: 17, raced: 0, failed: 0 });
  });

  test("a row that settled since the scan is raced, not released — its run earned that charge", async () => {
    findReturns([row("a", { credits: 5 }), row("b", { credits: 12 })]);
    // `b` finished late: the refund found it charged and did nothing.
    statusAfter({ a: "failed", b: "charged" });

    const result = await releaseStaleReservations({ now: NOW });

    expect(result).toMatchObject({ released: 1, creditsReturned: 5, raced: 1 });
  });

  test("one row that throws is counted and the sweep carries on", async () => {
    findReturns([row("a"), row("b"), row("c")]);
    statusAfter({ a: "failed", b: "failed", c: "failed" });
    failAndRefundLedger.mockImplementation(async ({ ledgerId }) => {
      if (ledgerId === "b") throw new Error("transaction aborted");
    });

    const result = await releaseStaleReservations({ now: NOW });

    expect(result).toMatchObject({ scanned: 3, released: 2, failed: 1 });
    // The third row was still tried: a single bad row must not end the run.
    expect(failAndRefundLedger).toHaveBeenCalledWith({ workspaceId: WS, ledgerId: "c" });
  });

  test("a row naming no usable workspace is counted, never refunded to nowhere", async () => {
    findReturns([row("a", { workspaceId: "not-an-object-id" })]);

    const result = await releaseStaleReservations({ now: NOW });

    expect(failAndRefundLedger).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, released: 0, failed: 1 });
  });

  test("a clean fleet is a run that found nothing and said so", async () => {
    findReturns([]);
    const result = await releaseStaleReservations({ now: NOW });
    expect(result).toMatchObject({ scanned: 0, released: 0, creditsReturned: 0, failed: 0 });
  });
});

describe("dryRun", () => {
  test("writes nothing at all", async () => {
    findReturns([row("a", { credits: 5 }), row("b", { credits: 12 })]);

    const result = await releaseStaleReservations({ now: NOW, dryRun: true });

    expect(failAndRefundLedger).not.toHaveBeenCalled();
    expect(ledgerFindById).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  test("still reports exactly what it would have released", async () => {
    findReturns([row("a", { credits: 5 }), row("b", { credits: 12 })]);

    const result = await releaseStaleReservations({ now: NOW, dryRun: true });

    expect(result).toMatchObject({ scanned: 2, released: 2, creditsReturned: 17 });
    expect(result.sample.map((s) => s.ledgerId)).toEqual(["a", "b"]);
    expect(result.sample[0]).toMatchObject({ workspaceId: WS, actionType: "history", creditsReserved: 5 });
    expect(result.sample[0]!.ageMs).toBe(180 * 60_000);
  });
});

describe("the sample", () => {
  test("is capped, so a large sweep cannot write an unbounded log line", async () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`id${i}`));
    findReturns(many);
    statusAfter(Object.fromEntries(many.map((r) => [r._id, "failed"])));

    const result = await releaseStaleReservations({ now: NOW });

    expect(result.released).toBe(40);
    expect(result.sample).toHaveLength(20);
  });
});
