/**
 * API route for `/api/admin/waitlist` — who is waiting, oldest first.
 *
 * Admin only (`requireAdmin`, which also refuses API keys: letting people into the product is not
 * a scope an agent can be granted). Oldest first because that is the order the queue promises on
 * `/waitlist`, and an admin approving from the top is what makes the number people see go down.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { UserModel } from "@/lib/models/User";
import { waitlistEnabled } from "@/lib/waitlist/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  _id: unknown;
  email?: unknown;
  name?: unknown;
  createdAt?: unknown;
  waitlistedAt?: unknown;
  approvedAt?: unknown;
  accessStatus?: unknown;
};

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "approved" ? "approved" : "waitlisted";
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  await connectMongo();

  const filter: Record<string, unknown> = { accessStatus: status, isTemp: { $ne: true } };
  if (status === "approved") {
    // Everyone is `approved` by default, including accounts made before the queue existed. The
    // list is meant to answer "who did we let in", so it is the ones with an approval on record.
    filter.approvedAt = { $ne: null };
  }
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ email: { $regex: safe, $options: "i" } }, { name: { $regex: safe, $options: "i" } }];
  }

  // Oldest first while waiting (the queue's own order); most recently approved first otherwise.
  const sort: Record<string, 1 | -1> = status === "approved" ? { approvedAt: -1 } : { waitlistedAt: 1, createdAt: 1 };

  const [rows, total] = await Promise.all([
    UserModel.find(filter)
      .select({ email: 1, name: 1, createdAt: 1, waitlistedAt: 1, approvedAt: 1, accessStatus: 1 })
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean() as unknown as Promise<Row[]>,
    UserModel.countDocuments(filter),
  ]);

  return NextResponse.json(
    {
      ok: true,
      enabled: waitlistEnabled(),
      total,
      page,
      limit,
      users: rows.map((u) => ({
        id: String(u._id),
        email: typeof u.email === "string" ? u.email : null,
        name: typeof u.name === "string" ? u.name : null,
        createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : null,
        waitlistedAt: u.waitlistedAt instanceof Date ? u.waitlistedAt.toISOString() : null,
        approvedAt: u.approvedAt instanceof Date ? u.approvedAt.toISOString() : null,
        accessStatus: u.accessStatus === "waitlisted" ? "waitlisted" : "approved",
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
