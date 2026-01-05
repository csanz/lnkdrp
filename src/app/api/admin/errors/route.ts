/**
 * Admin API route: `GET /api/admin/errors`
 *
 * Query ErrorEvent logs (sanitized, TTL-retained) with filters + cursor pagination.
 * Admin-only.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { ErrorEventModel } from "@/lib/models/ErrorEvent";
import type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";
import { serializeErrorEventForAdmin } from "@/lib/errors/serializeErrorEvent";

export const runtime = "nodejs";

function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
    if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  }
  return null;
}

function envLabel(): string {
  return (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "").trim().toLowerCase() || "unknown";
}

function isLocalhostBypassAllowed(request: Request) {
  // Only allow a localhost bypass in development when explicitly enabled.
  if (envLabel() !== "development") return false;
  if (parseBool(process.env.ADMIN_LOCALHOST_BYPASS) !== true) return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostBypassAllowed(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function parseDate(v: string | null): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function parseSeverity(v: string | null): ErrorSeverity | null {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "error" || s === "warn" || s === "info") return s;
  return null;
}

const CATEGORIES: Set<ErrorCategory> = new Set([
  "api",
  "worker",
  "cron",
  "stripe",
  "db",
  "auth",
  "ai",
  "credits",
  "unknown",
]);

function parseCategory(v: string | null): ErrorCategory | null {
  const s = (v ?? "").trim().toLowerCase() as ErrorCategory;
  return CATEGORIES.has(s) ? s : null;
}

type Cursor = { createdAt: string; id: string };

function encodeCursor(c: Cursor): string {
  const json = JSON.stringify(c);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): Cursor | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    const obj = JSON.parse(json) as { createdAt?: unknown; id?: unknown };
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!createdAt || !id) return null;
    if (!Number.isFinite(Date.parse(createdAt))) return null;
    if (!Types.ObjectId.isValid(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 100);

  const filter: Record<string, unknown> = {};

  const env = (url.searchParams.get("env") ?? "").trim();
  if (env) filter.env = env;

  const severity = parseSeverity(url.searchParams.get("severity"));
  if (severity) filter.severity = severity;

  const category = parseCategory(url.searchParams.get("category"));
  if (category) filter.category = category;

  const code = (url.searchParams.get("code") ?? "").trim();
  if (code) filter.code = code;

  const requestId = (url.searchParams.get("requestId") ?? "").trim();
  if (requestId) filter.requestId = requestId;

  const fingerprint = (url.searchParams.get("fingerprint") ?? "").trim();
  if (fingerprint) filter.fingerprint = fingerprint;

  const workspaceIdRaw = (url.searchParams.get("workspaceId") ?? "").trim();
  if (workspaceIdRaw && Types.ObjectId.isValid(workspaceIdRaw)) {
    filter.workspaceId = new Types.ObjectId(workspaceIdRaw);
  }

  const hasAnyFilters =
    Boolean(env) ||
    Boolean(severity) ||
    Boolean(category) ||
    Boolean(code) ||
    Boolean(workspaceIdRaw && Types.ObjectId.isValid(workspaceIdRaw)) ||
    Boolean(requestId) ||
    Boolean(fingerprint);

  const now = new Date();
  const sinceRaw = parseDate(url.searchParams.get("since"));
  const untilRaw = parseDate(url.searchParams.get("until"));
  const effectiveUntil = untilRaw ?? now;

  // Guardrails:
  // - If no filters are provided, force a narrow default window (last 24h).
  // - Enforce max query window of 30 days (if caller requests larger, return 400).
  const forcedSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const defaultSinceForBoundedRange = new Date(effectiveUntil.getTime() - 30 * 24 * 60 * 60 * 1000);
  const effectiveSince = sinceRaw ?? (hasAnyFilters ? defaultSinceForBoundedRange : forcedSince);

  const maxRangeMs = 30 * 24 * 60 * 60 * 1000;
  if (sinceRaw && effectiveUntil.getTime() - sinceRaw.getTime() > maxRangeMs) {
    return NextResponse.json({ error: "Time range too large (max 30 days)" }, { status: 400 });
  }
  if (sinceRaw && untilRaw && untilRaw.getTime() - sinceRaw.getTime() > maxRangeMs) {
    return NextResponse.json({ error: "Time range too large (max 30 days)" }, { status: 400 });
  }

  filter.createdAt = {
    ...(effectiveSince ? { $gte: effectiveSince } : {}),
    ...(effectiveUntil ? { $lte: effectiveUntil } : {}),
  };

  // Cursor pagination (desc): createdAt desc, _id desc
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (cursor) {
    const cDate = new Date(cursor.createdAt);
    const cId = new Types.ObjectId(cursor.id);
    filter.$or = [{ createdAt: { $lt: cDate } }, { createdAt: cDate, _id: { $lt: cId } }];
  }

  await connectMongo();
  const docs = await ErrorEventModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select({
      createdAt: 1,
      env: 1,
      severity: 1,
      category: 1,
      code: 1,
      message: 1,
      stack: 1,
      route: 1,
      method: 1,
      statusCode: 1,
      requestId: 1,
      workspaceId: 1,
      userId: 1,
      uploadId: 1,
      docId: 1,
      runId: 1,
      model: 1,
      fingerprint: 1,
      meta: 1,
      lastSeenAt: 1,
    })
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page.length ? page[page.length - 1] : null;
  const nextCursor = hasMore && last?.createdAt && last?._id ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: String(last._id) }) : null;

  return NextResponse.json({
    ok: true,
    items: page.map((d) => serializeErrorEventForAdmin(d)),
    nextCursor,
  });
}


