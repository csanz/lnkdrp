/**
 * Admin API route: `POST /api/admin/credits/release`
 *
 * Gives back the credits held by one reservation that was never settled — the row the anomalies
 * table reports as `stale_pending`.
 *
 * The hourly `credits-stale-reservations` job does this on its own, and this is the lever for when
 * an operator is already looking at the row and does not want to wait for the next run. Both go
 * through `failAndRefundLedger`, which re-reads the row inside a transaction and refuses to act
 * unless it is still `pending`, so pressing this twice, or pressing it while the sweeper runs,
 * cannot refund twice.
 *
 * It takes a ledger id rather than a workspace and an amount, which is the difference between this
 * and `/mutate`: granting credits back by hand leaves the row pending, keeps the anomaly firing and
 * leaves `usedThisCycle` overstated. This resolves the row that caused the loss.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { failAndRefundLedger } from "@/lib/credits/creditService";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const ledgerId = typeof (body as { ledgerId?: unknown })?.ledgerId === "string" ? ((body as { ledgerId: string }).ledgerId).trim() : "";
  if (!Types.ObjectId.isValid(ledgerId)) {
    return NextResponse.json({ error: "ledgerId is required (Mongo ObjectId)" }, { status: 400 });
  }

  await connectMongo();
  const row = (await CreditLedgerModel.findById(ledgerId)
    .select({ workspaceId: 1, status: 1, eventType: 1, creditsReserved: 1, actionType: 1 })
    .lean()) as {
    workspaceId?: unknown;
    status?: unknown;
    eventType?: unknown;
    creditsReserved?: unknown;
    actionType?: unknown;
  } | null;

  if (!row) return NextResponse.json({ error: "No such ledger row" }, { status: 404 });

  /**
   * Only a reservation, and only an unsettled one.
   *
   * The ledger also carries grant rows, which are written `charged` and are not reservations at
   * all; refunding one would hand a workspace credits nobody took from it. Saying no here rather
   * than trusting the caller keeps that impossible from the API's side, not just the UI's.
   */
  if (row.eventType !== "ai_run") {
    return NextResponse.json({ error: "Only an ai_run reservation can be released" }, { status: 400 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { ok: false, released: false, status: String(row.status ?? "unknown"), message: "That reservation is already settled" },
      { status: 409 },
    );
  }

  const workspaceId = row.workspaceId ? String(row.workspaceId) : "";
  if (!Types.ObjectId.isValid(workspaceId)) {
    return NextResponse.json({ error: "That row names no workspace to refund" }, { status: 400 });
  }

  await failAndRefundLedger({ workspaceId, ledgerId });

  // Report what actually happened rather than what was asked for: the refund is a no-op on a row
  // that settled between the read above and the write, and the operator should see that.
  const after = (await CreditLedgerModel.findById(ledgerId).select({ status: 1 }).lean()) as { status?: unknown } | null;
  const released = after?.status === "failed";

  // eslint-disable-next-line no-console
  console.warn("[admin] credit reservation release", {
    ledgerId,
    workspaceId,
    actionType: typeof row.actionType === "string" ? row.actionType : "unknown",
    creditsReserved: Number(row.creditsReserved) || 0,
    released,
    by: auth.email ?? auth.userId,
  });

  return NextResponse.json({
    ok: true,
    released,
    status: String(after?.status ?? "unknown"),
    creditsReturned: released ? Number(row.creditsReserved) || 0 : 0,
  });
}
