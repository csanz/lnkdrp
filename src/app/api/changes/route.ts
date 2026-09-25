/**
 * `GET /api/changes` — the workspace's revision history: every replacement's change record,
 * newest first, across all its documents.
 *
 * `GET /api/docs/:docId/changes` answers "what changed in this document"; this answers "what
 * changed in the workspace", which is the question an agent asks first ("what changed last week,
 * and who did it"). It reads the same `DocChange` rows the processing job writes on every
 * replacement, joined to the document's title and the replacer's name, and can add a contributor
 * tally for the same window.
 *
 * Query:
 * - `since`: an ISO date, or a relative window `24h`, `7d`, `30d`, `this_week` (Monday 00:00 UTC),
 *   `this_month` (the 1st, 00:00 UTC). Omit for all time.
 * - `docId`: one document only (must be in the workspace, else 404).
 * - `limit`: 1-50, default 20. `cursor`: `nextCursor` from the previous page (keyset on
 *   `createdDate`, then `_id`, so a replacement landing mid-page never shifts the next one).
 * - `contributors=1`: adds `contributors` (per member: replacements, documents touched, last at)
 *   and `agents` (per MCP/API client, from the `doc.replaced` activity rows) for the same window.
 *
 * Tenancy: rows are selected through the workspace's live documents rather than by
 * `DocChange.orgId`, because older rows can carry no `orgId` or a stale one (the per-document
 * route reads by `docId` for the same reason). A deleted document's history is not listed.
 *
 * Security: any member of the workspace (viewer and up) may read; API keys with `read` may read.
 * Temp users get an empty list, not a 401, like `/api/activity`. Free text (summaries, titles,
 * names) is the document's or a member's and is returned as data; MCP wraps it as untrusted.
 * Caching: `no-store`. No side effects.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { workspaceListableDocFilter } from "@/lib/docs/visibility";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { DocChangeModel } from "@/lib/models/DocChange";
import { UserModel } from "@/lib/models/User";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Documents one workspace list will consider; past this the newest documents win and the response says so. */
const DOC_SCAN_LIMIT = 5000;

type Cursor = { createdDate: Date; id: Types.ObjectId };

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdDate.toISOString()}:${String(c.id)}`, "utf8").toString("base64url");
}

/** Decode a keyset cursor; null for anything malformed, which callers treat as "first page". */
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const idx = s.lastIndexOf(":");
    if (idx <= 0) return null;
    const date = new Date(s.slice(0, idx));
    const id = s.slice(idx + 1);
    if (!Number.isFinite(date.getTime()) || !Types.ObjectId.isValid(id)) return null;
    return { createdDate: date, id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}

/**
 * `since` as a Date: a relative window (`24h`, `7d`, `this_week`, `this_month`) or an ISO date.
 * Invalid input answers null so the caller can 400 rather than silently list everything.
 */
function parseSince(raw: string | null, now: Date = new Date()): { since: Date | null; invalid: boolean } {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return { since: null, invalid: false };
  const rel = /^(\d{1,4})\s*(h|d)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === "h" ? n * 3_600_000 : n * 86_400_000;
    return { since: new Date(now.getTime() - ms), invalid: false };
  }
  if (s === "this_week" || s === "this-week") {
    const day = now.getUTCDay(); // 0 = Sunday
    const back = (day + 6) % 7; // days since Monday
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    return { since: monday, invalid: false };
  }
  if (s === "this_month" || s === "this-month") {
    return { since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), invalid: false };
  }
  const iso = new Date(raw ?? "");
  if (Number.isFinite(iso.getTime())) return { since: iso, invalid: false };
  return { since: null, invalid: true };
}

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") {
    return applyTempUserHeaders(NextResponse.json({ items: [], nextCursor: null, since: null }, { headers: { "cache-control": "no-store" } }), actor);
  }
  try {
    const url = new URL(request.url);
    const { since, invalid } = parseSince(url.searchParams.get("since"));
    if (invalid) return NextResponse.json({ error: "since must be an ISO date or one of 24h, 7d, 30d, this_week, this_month" }, { status: 400 });
    const docIdRaw = (url.searchParams.get("docId") ?? "").trim();
    if (docIdRaw && !Types.ObjectId.isValid(docIdRaw)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT));
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const wantContributors = url.searchParams.get("contributors") === "1";

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // The workspace's live documents, which is what "the workspace's history" means here. With
    // `?docId=` it is one document instead, and that is the shared by-id match (plus the same
    // visibility rule the listing applies) rather than the listing filter with an `_id` bolted on.
    const docFilter: Record<string, unknown> = docIdRaw
      ? { ...buildDocMatch(new Types.ObjectId(docIdRaw), orgId, legacyUserId, allowLegacyByUserId), ...workspaceListableDocFilter() }
      : allowLegacyByUserId
        ? { isDeleted: { $ne: true }, ...workspaceListableDocFilter(), $or: [{ orgId }, { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] }] }
        : { orgId, isDeleted: { $ne: true }, ...workspaceListableDocFilter() };
    const docs = (await DocModel.find(docFilter)
      .select({ _id: 1, title: 1, shareId: 1, updatedDate: 1 })
      .sort({ updatedDate: -1 })
      .limit(DOC_SCAN_LIMIT)
      .lean()) as Array<{ _id: Types.ObjectId; title?: string | null; shareId?: string | null }>;
    if (docIdRaw && docs.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const docById = new Map(docs.map((d) => [String(d._id), d]));
    const docIds = docs.map((d) => d._id);
    const truncatedDocs = docs.length >= DOC_SCAN_LIMIT;

    const base: Record<string, unknown> = { docId: { $in: docIds } };
    if (since) base.createdDate = { $gte: since };
    const pageFilter: Record<string, unknown> = cursor
      ? { $and: [base, { $or: [{ createdDate: { $lt: cursor.createdDate } }, { createdDate: cursor.createdDate, _id: { $lt: cursor.id } }] }] }
      : base;

    const rows = (await DocChangeModel.find(pageFilter)
      .select({ _id: 1, docId: 1, fromVersion: 1, toVersion: 1, createdDate: 1, createdByUserId: 1, changedPageCount: 1, "diff.summary": 1, "diff.changes.type": 1, "diff.pagesThatChanged.pageNumber": 1 })
      .sort({ createdDate: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as Array<Record<string, any>>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const userIds = new Set<string>();
    for (const r of page) if (r.createdByUserId) userIds.add(String(r.createdByUserId));

    // Contributor tallies for the same window (not the page): who replaced what, and through which client.
    let contributors: Array<Record<string, unknown>> | undefined;
    let agents: Array<Record<string, unknown>> | undefined;
    if (wantContributors) {
      const tally = (await DocChangeModel.aggregate([
        { $match: base },
        { $group: { _id: "$createdByUserId", replacements: { $sum: 1 }, docs: { $addToSet: "$docId" }, lastAt: { $max: "$createdDate" }, firstAt: { $min: "$createdDate" } } },
        { $sort: { replacements: -1, lastAt: -1 } },
        { $limit: 50 },
      ])) as Array<{ _id: Types.ObjectId | null; replacements: number; docs: Types.ObjectId[]; lastAt: Date; firstAt: Date }>;
      for (const t of tally) if (t._id) userIds.add(String(t._id));
      const activityMatch: Record<string, unknown> = { orgId, type: "doc.replaced", "agent.client": { $type: "string" } };
      if (since) activityMatch.createdDate = { $gte: since };
      if (docIdRaw) activityMatch.docId = new Types.ObjectId(docIdRaw);
      const byAgent = (await ActivityEventModel.aggregate([
        { $match: activityMatch },
        { $group: { _id: { client: "$agent.client", userId: "$userId" }, replacements: { $sum: 1 }, lastAt: { $max: "$createdDate" } } },
        { $sort: { replacements: -1 } },
        { $limit: 50 },
      ])) as Array<{ _id: { client: string; userId: Types.ObjectId | null }; replacements: number; lastAt: Date }>;
      for (const a of byAgent) if (a._id.userId) userIds.add(String(a._id.userId));
      contributors = tally.map((t) => ({ userId: t._id ? String(t._id) : null, replacements: t.replacements, documents: t.docs.length, firstAt: t.firstAt.toISOString(), lastAt: t.lastAt.toISOString() }));
      agents = byAgent.map((a) => ({ client: a._id.client, userId: a._id.userId ? String(a._id.userId) : null, replacements: a.replacements, lastAt: a.lastAt.toISOString() }));
    }

    const users = userIds.size
      ? ((await UserModel.find({ _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) } })
          .select({ _id: 1, name: 1, email: 1 })
          .lean()) as Array<{ _id: Types.ObjectId; name?: string | null; email?: string | null }>)
      : [];
    const userById = new Map(users.map((u) => [String(u._id), { name: (u.name ?? "").trim() || null, email: (u.email ?? "").trim() || null }]));
    const by = (id: unknown) => {
      const key = id ? String(id) : "";
      if (!key) return null;
      const u = userById.get(key);
      return { userId: key, name: u?.name ?? null, email: u?.email ?? null };
    };
    if (contributors) for (const c of contributors) Object.assign(c, { name: by(c.userId)?.name ?? null, email: by(c.userId)?.email ?? null });
    if (agents) for (const a of agents) Object.assign(a, { name: by(a.userId)?.name ?? null });

    const items = page.map((r) => {
      const d = docById.get(String(r.docId));
      return {
        id: String(r._id),
        docId: String(r.docId),
        doc: d ? { title: (d.title ?? "").trim() || null, shareId: d.shareId ?? null } : null,
        fromVersion: typeof r.fromVersion === "number" ? r.fromVersion : null,
        toVersion: typeof r.toVersion === "number" ? r.toVersion : null,
        at: r.createdDate ? new Date(r.createdDate).toISOString() : null,
        by: by(r.createdByUserId),
        summary: typeof r.diff?.summary === "string" ? r.diff.summary : "",
        changedPageCount: typeof r.changedPageCount === "number" ? r.changedPageCount : null,
        changeCount: Array.isArray(r.diff?.changes) ? r.diff.changes.length : 0,
        pagesChanged: Array.isArray(r.diff?.pagesThatChanged) ? r.diff.pagesThatChanged.length : 0,
      };
    });
    const last = page[page.length - 1];
    const nextCursor = hasMore && last?.createdDate ? encodeCursor({ createdDate: new Date(last.createdDate), id: last._id }) : null;

    return applyTempUserHeaders(
      NextResponse.json(
        {
          items,
          nextCursor,
          since: since ? since.toISOString() : null,
          ...(truncatedDocs ? { note: `only the ${DOC_SCAN_LIMIT} most recently updated documents were considered` } : {}),
          ...(contributors ? { contributors, agents } : {}),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not load the revision history" });
  }
}
