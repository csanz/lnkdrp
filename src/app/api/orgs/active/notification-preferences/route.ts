/**
 * API route for `/api/orgs/active/notification-preferences`.
 *
 * Read/update the current user's notification preferences for the active org.
 * Auth required (internal workspace members only).
 *
 * Three email modes live on the membership, each `off | daily | immediate`:
 * - `viewEmailMode`: someone opened one of the workspace's share links
 * - `docUpdateEmailMode`: a doc was replaced and changes were introduced
 * - `repoLinkRequestEmailMode`: a repository link was requested / needs review
 *
 * A missing value reads as `daily` (the schema default). Updates are accepted on both POST
 * (the existing client) and PATCH; either takes any subset of the three modes.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Mode = "off" | "daily" | "immediate";

/** The per-member email mode fields this route reads and writes. */
const MODE_KEYS = ["viewEmailMode", "docUpdateEmailMode", "repoLinkRequestEmailMode"] as const;
type ModeKey = (typeof MODE_KEYS)[number];

function isMode(v: unknown): v is Mode | "immediately" {
  // Accept legacy/canonical `immediate` and tolerate `immediately` as an alias from clients.
  return v === "off" || v === "daily" || v === "immediate" || v === "immediately";
}

function normalizeMode(v: Mode | "immediately"): Mode {
  return v === "immediately" ? "immediate" : v;
}

/** Stored value, or `daily` when the field is missing or not a known mode. */
function readMode(v: unknown): Mode {
  return isMode(v) ? normalizeMode(v) : "daily";
}

export async function GET(request: Request) {
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  await connectMongo();
  const orgId = new Types.ObjectId(actor.orgId);
  const userId = new Types.ObjectId(actor.userId);
  const membership = await OrgMembershipModel.findOne({
    orgId,
    userId,
    isDeleted: { $ne: true },
  })
    .select({
      viewEmailMode: 1,
      docUpdateEmailMode: 1,
      repoLinkRequestEmailMode: 1,
      docUpdateDigestTimezone: 1,
      docUpdateDigestTimeLocal: 1,
    })
    .lean();
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const m = membership as Record<string, unknown>;

  return NextResponse.json(
    {
      ok: true,
      orgId: actor.orgId,
      userId: actor.userId,
      viewEmailMode: readMode(m.viewEmailMode),
      docUpdateEmailMode: readMode(m.docUpdateEmailMode),
      repoLinkRequestEmailMode: readMode(m.repoLinkRequestEmailMode),
      docUpdateDigestTimezone: typeof m.docUpdateDigestTimezone === "string" ? m.docUpdateDigestTimezone : null,
      docUpdateDigestTimeLocal: typeof m.docUpdateDigestTimeLocal === "string" ? m.docUpdateDigestTimeLocal : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function updatePreferences(request: Request) {
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const raw = (await request.json().catch(() => ({}))) as unknown;
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<Record<ModeKey, unknown>>;
  const set: Partial<Record<ModeKey, Mode>> = {};
  for (const key of MODE_KEYS) {
    const value = body[key];
    if (typeof value === "undefined") continue;
    if (!isMode(value)) return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 });
    set[key] = normalizeMode(value);
  }
  if (!Object.keys(set).length) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  await connectMongo();
  const orgId = new Types.ObjectId(actor.orgId);
  const userId = new Types.ObjectId(actor.userId);
  const res = await OrgMembershipModel.updateOne(
    {
      orgId,
      userId,
      isDeleted: { $ne: true },
    },
    { $set: { ...set, updatedDate: new Date() } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...set }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  return updatePreferences(request);
}

export async function PATCH(request: Request) {
  return updatePreferences(request);
}
