/**
 * `GET /api/health` — liveness + a Mongo ping, for uptime monitors and post-deploy checks.
 *
 * Unauthenticated and cheap. Returns 200 `{ ok: true, mongo: "ok", version, env }` or 503 with
 * `mongo: "error"` when the database is unreachable. Never reveals secrets or connection strings.
 */
import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectMongo } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null;
  try {
    await connectMongo();
    const admin = mongoose.connection.db?.admin();
    if (!admin) throw new Error("no db handle");
    await admin.ping();
    return NextResponse.json({ ok: true, mongo: "ok", version, env, time: new Date().toISOString() }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: false, mongo: "error", version, env, time: new Date().toISOString() }, { status: 503, headers: NO_STORE });
  }
}
