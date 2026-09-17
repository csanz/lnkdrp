/**
 * API route for `/api/activity`.
 *
 * Lists the active workspace's activity feed (newest first) with cursor pagination.
 * Read-only: viewers and above may read; temp users get an empty feed (not a 401) because they
 * have no workspace history worth showing and the app shell may probe this endpoint before sign-in.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UserModel } from "@/lib/models/User";
import { debugLog } from "@/lib/debug";
import { errorJson } from "@/lib/http/errorResponse";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { agentLabel } from "@/lib/activity/log";
import { ShareViewModel } from "@/lib/models/ShareView";
import { getWorkspacePlan } from "@/lib/billing/planLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
/** Bound on `type=` filter entries (defensive; the UI sends at most six). */
const MAX_TYPE_FILTERS = 32;

type Cursor = { createdDate: Date; id: Types.ObjectId };

/** Encode a pagination cursor as opaque base64 of `"<ISO date>:<_id>"`. */
function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdDate.toISOString()}:${String(c.id)}`, "utf8").toString("base64url");
}

/** Decode a cursor; returns null for anything malformed (caller treats as "no cursor"). */
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0) return null;
  const dateStr = decoded.slice(0, sep);
  const idStr = decoded.slice(sep + 1);
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t) || !Types.ObjectId.isValid(idStr)) return null;
  return { createdDate: new Date(t), id: new Types.ObjectId(idStr) };
}

/**
 * `GET /api/activity`
 *
 * Query: `limit` (1–100, default 40), `cursor` (opaque, from `nextCursor`), `type` (comma list),
 * `docId`. Response: `{ items, nextCursor }` with actor/doc/project resolved via one `$in` each.
 * Errors: 403 when the caller is not a workspace member; 400 for unexpected failures.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = decodeCursor(cursorRaw);
    // A cursor that does not decode used to be read as "no cursor", so a client holding a corrupted
    // one got page one back with a fresh nextCursor and looped over it forever.
    if (cursorRaw && !cursor) {
      return NextResponse.json({ error: "Invalid cursor. Pass nextCursor exactly as returned, or omit it for the first page." }, { status: 400 });
    }
    const types = (url.searchParams.get("type") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z_]+\.[a-z_]+$/.test(s))
      .slice(0, MAX_TYPE_FILTERS);
    const docIdRaw = (url.searchParams.get("docId") ?? "").trim();
    const docId = docIdRaw && Types.ObjectId.isValid(docIdRaw) ? new Types.ObjectId(docIdRaw) : null;
    // Who did it: "me" (my own actions in a browser), "team" (other members' browser actions),
    // "agents" (anything an MCP/API client did, whoever owns the key). Anything else = everyone.
    const whoRaw = (url.searchParams.get("who") ?? "").trim();
    const who: "me" | "team" | "agents" | null = whoRaw === "me" || whoRaw === "team" || whoRaw === "agents" ? whoRaw : null;

    debugLog(2, "[api/activity] GET", { limit, hasCursor: Boolean(cursor), types: types.length, docId: Boolean(docId) });

    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      // Temp users have no workspace history; return an empty feed rather than a 401.
      return applyTempUserHeaders(
        NextResponse.json({ items: [], nextCursor: null }, { headers: { "cache-control": "no-store" } }),
        actor,
      );
    }

    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);

    const filter: Record<string, unknown> = { orgId };
    if (types.length) filter.type = { $in: types };
    if (docId) filter.docId = docId;
    if (who === "agents") filter["agent.client"] = { $exists: true, $ne: null };
    else if (who === "me") {
      filter.userId = new Types.ObjectId(actor.userId);
      filter["agent.client"] = { $exists: false };
      // "Me" is what I did in the app, not me reading my own link as a recipient.
      filter.actorKind = { $nin: ["viewer", "secret"] };
    } else if (who === "team") {
      filter.actorKind = "user";
      filter.userId = { $ne: new Types.ObjectId(actor.userId) };
      filter["agent.client"] = { $exists: false };
    }
    if (cursor) {
      filter.$or = [
        { createdDate: { $lt: cursor.createdDate } },
        { createdDate: cursor.createdDate, _id: { $lt: cursor.id } },
      ];
    }

    // Fetch one extra row to know whether another page exists.
    const rows = await ActivityEventModel.find(filter)
      .sort({ createdDate: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Resolve actors, docs and projects with one `$in` query each.
    const userIds = new Map<string, Types.ObjectId>();
    const docIds = new Map<string, Types.ObjectId>();
    const projectIds = new Map<string, Types.ObjectId>();
    for (const r of page) {
      if (r.userId) userIds.set(String(r.userId), r.userId as Types.ObjectId);
      if (r.docId) docIds.set(String(r.docId), r.docId as Types.ObjectId);
      if (r.projectId) projectIds.set(String(r.projectId), r.projectId as Types.ObjectId);
    }

    // Recipients who introduced themselves after their "viewed"/"downloaded" row was written: pick
    // up the name from their ShareView row (keyed by the viewer key stored on the event).
    const viewerKeys = new Map<string, { shareId: string; botIdHash: string }>();
    for (const r of page) {
      if (r.type !== "share.viewed" && r.type !== "share.downloaded") continue;
      const m = (r.meta ?? {}) as Record<string, unknown>;
      if (typeof m.viewerName === "string" && m.viewerName) continue;
      if (typeof m.viewerKey === "string" && m.viewerKey && typeof m.shareId === "string" && m.shareId) {
        viewerKeys.set(`${m.shareId}:${m.viewerKey}`, { shareId: m.shareId, botIdHash: m.viewerKey });
      }
    }

    const [users, docs, projects, knownViewers, plan] = await Promise.all([
      userIds.size
        ? UserModel.find({ _id: { $in: Array.from(userIds.values()) } })
            .select({ _id: 1, name: 1, email: 1, isTemp: 1 })
            .lean()
        : Promise.resolve([]),
      docIds.size
        ? DocModel.find({ _id: { $in: Array.from(docIds.values()) } })
            .select({ _id: 1, title: 1, shareId: 1, isDeleted: 1 })
            .lean()
        : Promise.resolve([]),
      projectIds.size
        ? ProjectModel.find({ _id: { $in: Array.from(projectIds.values()) } })
            .select({ _id: 1, name: 1 })
            .lean()
        : Promise.resolve([]),
      viewerKeys.size
        ? ShareViewModel.find({ $or: Array.from(viewerKeys.values()) })
            .select({ shareId: 1, botIdHash: 1, viewerName: 1, viewerEmail: 1 })
            .lean()
        : Promise.resolve([]),
      getWorkspacePlan(orgId).catch(() => "free" as const),
    ]);
    const viewerByKey = new Map<string, { name: string | null; email: string | null }>();
    for (const v of knownViewers as Array<{ shareId?: string; botIdHash?: string; viewerName?: string | null; viewerEmail?: string | null }>) {
      if (v.shareId && v.botIdHash) viewerByKey.set(`${v.shareId}:${v.botIdHash}`, { name: v.viewerName ?? null, email: v.viewerEmail ?? null });
    }
    // Who read a document is deep analytics, a Pro feature: on Free, recipient rows stay anonymous
    // here exactly as they are on the metrics page.
    const showViewerIdentity = plan === "pro";

    const userById = new Map<string, { name: string | null; email: string | null; isTemp: boolean }>();
    for (const u of users) {
      userById.set(String(u._id), {
        name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : null,
        email: typeof u.email === "string" && u.email.trim() ? u.email.trim() : null,
        isTemp: Boolean((u as { isTemp?: unknown }).isTemp),
      });
    }
    const docById = new Map<string, { title: string | null; shareId: string | null; deleted: boolean }>();
    for (const d of docs) {
      docById.set(String(d._id), {
        title: typeof d.title === "string" && d.title.trim() ? d.title.trim() : null,
        shareId: typeof d.shareId === "string" && d.shareId ? d.shareId : null,
        deleted: Boolean((d as { isDeleted?: unknown }).isDeleted),
      });
    }
    const projectById = new Map<string, { name: string | null }>();
    for (const p of projects) {
      projectById.set(String(p._id), { name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null });
    }

    const items = page.map((r) => {
      const isRecipientRow = r.actorKind === "viewer" && (r.type === "share.viewed" || r.type === "share.downloaded");
      const hideIdentity = isRecipientRow && !showViewerIdentity;
      const uid = r.userId && !hideIdentity ? String(r.userId) : null;
      const u = uid ? userById.get(uid) ?? null : null;
      let meta = r.meta && typeof r.meta === "object" ? { ...(r.meta as Record<string, unknown>) } : {};
      if (isRecipientRow) {
        const known = typeof meta.viewerKey === "string" && typeof meta.shareId === "string" ? viewerByKey.get(`${meta.shareId}:${meta.viewerKey}`) : undefined;
        if (known && !meta.viewerName) meta = { ...meta, viewerName: known.name, viewerEmail: meta.viewerEmail ?? known.email };
        delete meta.viewerKey;
        if (hideIdentity) {
          delete meta.viewerName;
          delete meta.viewerEmail;
        }
      }
      const did = r.docId ? String(r.docId) : null;
      const d = did ? docById.get(did) ?? null : null;
      const pid = r.projectId ? String(r.projectId) : null;
      const p = pid ? projectById.get(pid) ?? null : null;
      const agent = r.agent && typeof r.agent.client === "string" ? { client: r.agent.client, version: r.agent.version ?? null } : null;
      const createdDate = r.createdDate instanceof Date ? r.createdDate : new Date(String(r.createdDate));
      const isProjectEvent = r.type === "request_repo.created";

      return {
        id: String(r._id),
        type: r.type,
        createdDate: createdDate.toISOString(),
        actor: {
          userId: uid,
          name: u?.name ?? null,
          email: u?.email ?? null,
          kind: r.actorKind,
        },
        agent: agent ? { client: agent.client, label: agentLabel(agent) ?? agent.client, version: agent.version } : null,
        doc: did
          ? {
              id: did,
              // Prefer the denormalized title (survives renames/deletes); fall back to the live doc.
              title: (isProjectEvent ? null : r.title) ?? d?.title ?? null,
              shareId: d?.shareId ?? null,
              deleted: !d || d.deleted,
            }
          : null,
        project: pid ? { id: pid, name: p?.name ?? (isProjectEvent ? r.title ?? null : null) } : null,
        meta,
      };
    });

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            createdDate: last.createdDate instanceof Date ? last.createdDate : new Date(String(last.createdDate)),
            id: last._id as Types.ObjectId,
          })
        : null;

    return NextResponse.json({ items, nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorJson(err, { status: 400, publicMessage: "Could not load activity", context: "[api/activity] GET failed" });
  }
}
