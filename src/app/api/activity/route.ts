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
import { containedDocIds } from "@/lib/docs/visibility";
import { ProjectModel } from "@/lib/models/Project";
import { UserModel } from "@/lib/models/User";
import { debugLog } from "@/lib/debug";
import { errorJson } from "@/lib/http/errorResponse";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { agentLabel } from "@/lib/activity/log";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { splitProjectViewerKey, viewerKeyMatchClause } from "@/lib/share/projectPublic";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { feedHiddenClauses } from "@/lib/activity/feedVisibility";
import { buildActorFilter } from "@/lib/people/actorFilter";
import { agentKey, contributorHref, parseContributorKey, personKey } from "@/lib/people/contributorKey";

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
 * Query: `limit` (1-100, default 40), `cursor` (opaque, from `nextCursor`), `type` (comma list),
 * `docId`, `projectId`, `who`, `actor`. Response: `{ items, nextCursor }` with actor/doc/project
 * resolved via one `$in` each.
 * Errors: 403 when the caller is not a workspace member; 400 for unexpected failures.
 *
 * **`actor` vs `who`.** `actor` is one named contributor (`user:<id>` or `agent:<client>@<owner>`,
 * see `src/lib/people/contributorKey.ts`); `who` is a coarse bucket of the caller's own making
 * ("me", "team", "agents"). They answer the same axis of the question, so when `actor` is present
 * `who` is ignored rather than rejected: the pages that page a contributor's feed pass `actor` into
 * the same hook the workspace feed uses, and a stale `who` left in a URL must not 400 a page that
 * is otherwise perfectly well specified. Everything else (`limit`, `cursor`, `type`, `docId`,
 * `projectId`) still ANDs with it.
 *
 * `actor` also turns off the workspace feed's "documents kept inside a room" exclusion. That rule
 * keeps a room's traffic out of the workspace-wide list; a contributor's page is not that list, and
 * applying it there would hide a person's own work from their own page because of where the
 * document happens to be filed.
 */
/**
 * Events written by a recipient rather than by someone in the workspace.
 *
 * Two rules hang off this set, and both were once written out by hand as
 * `share.viewed || share.downloaded`, which is how arriving in a data room and entering a password
 * ended up outside them: identities on these rows are Pro-gated, and a name given *after* the row
 * was written is joined back onto it from the reader's `ShareView`.
 */
const RECIPIENT_TYPES: ReadonlySet<string> = new Set([
  "share.viewed",
  "share.downloaded",
  "project.landed",
  "share.unlocked",
  // An introduction is a recipient's row like any other: it carries their name, it must follow the
  // identity gate, and the person it names has a reader page worth reaching.
  "viewer.introduced",
  // The end of a visit is the reader's row too: same identity gate, same reader page.
  "share.visit_briefed",
]);

/**
 * The page about the person on a recipient row, when there is one.
 *
 * Computed here rather than in the browser because `meta.viewerKey` — the device digest this is
 * built from — is deleted before the row is sent, and should stay deleted: the client has no use
 * for a raw identifier, only for the address it points at.
 *
 * Which page depends on where the reading is counted, not on which row this is. A document opened
 * through a project link belongs to the project (`docScope.ts`), and those rows carry a
 * `projectId`. The key matches how the reader pages are addressed: `u_<userId>` for a signed-in
 * reader, `a_<digest>` otherwise, with the `<digest>.<docId>` composite a project link writes
 * reduced back to the person.
 */
function readerHrefFor(
  type: string,
  meta: Record<string, unknown>,
  ids: { userId: string | null; docId: string | null; projectId: string | null },
): string | null {
  if (!RECIPIENT_TYPES.has(type)) return null;
  const rawKey = typeof meta.viewerKey === "string" ? meta.viewerKey.trim() : "";
  const digest = splitProjectViewerKey(rawKey).botIdHash;
  const key = meta.authenticated === true && ids.userId ? `u_${ids.userId}` : digest ? `a_${digest}` : null;
  if (!key) return null;
  if (ids.projectId) return `/project/${encodeURIComponent(ids.projectId)}/metrics/viewer/${key}`;
  if (ids.docId) return `/doc/${encodeURIComponent(ids.docId)}/metrics/viewer/${key}`;
  return null;
}

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
    const projectIdRaw = (url.searchParams.get("projectId") ?? "").trim();
    const projectId = projectIdRaw && Types.ObjectId.isValid(projectIdRaw) ? new Types.ObjectId(projectIdRaw) : null;
    const docId = docIdRaw && Types.ObjectId.isValid(docIdRaw) ? new Types.ObjectId(docIdRaw) : null;
    // Who did it: "me" (my own actions in a browser), "team" (other members' browser actions),
    // "agents" (anything an MCP/API client did, whoever owns the key). Anything else = everyone.
    const whoRaw = (url.searchParams.get("who") ?? "").trim();
    const who: "me" | "team" | "agents" | null = whoRaw === "me" || whoRaw === "team" || whoRaw === "agents" ? whoRaw : null;
    // One named contributor. Parsed here, before any work is done, so a typo answers 400 rather
    // than reaching Mongo as a filter on nothing and coming back as a plausible empty feed.
    const actorRaw = (url.searchParams.get("actor") ?? "").trim();
    const actorKey = actorRaw ? parseContributorKey(actorRaw) : null;
    if (actorRaw && !actorKey) {
      return NextResponse.json({ error: "Invalid actor. Pass user:<userId> or agent:<client>@<ownerUserId>." }, { status: 400 });
    }

    debugLog(2, "[api/activity] GET", { limit, hasCursor: Boolean(cursor), types: types.length, docId: Boolean(docId), actor: Boolean(actorKey) });

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
    // Instrumentation rows (funnel steps, Checkout starts, feature-gate refusals) are not the
    // workspace's history and stay out unless a type filter names them; see feedVisibility.ts.
    else filter.$nor = feedHiddenClauses();
    if (docId) filter.docId = docId;
    // A project's own feed; otherwise the workspace feed, which leaves out the rows of documents
    // kept inside their room (docs/prds/lnkdrp-project-home.md, decision 5).
    if (projectId) filter.projectId = projectId;
    // `!actorKey`: a contributor's page lists everything they did, room-contained documents
    // included. See the route comment; without this a person's page silently drops their own work.
    else if (!docId && !actorKey) {
      const contained = await containedDocIds(orgId);
      if (contained.length) filter.docId = { $nin: contained };
    }
    // One contributor wins over the `who` bucket; the two are the same axis (see the route comment).
    // `buildActorFilter` is shared with the profile endpoint so the header and the feed under it
    // cannot come to different conclusions, and its person branch excludes viewer-kind rows by
    // construction, so `actor=user:<id>` can never be turned into a reader's reading history.
    if (actorKey) Object.assign(filter, buildActorFilter(actorKey));
    else if (who === "agents") filter["agent.client"] = { $exists: true, $ne: null };
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

    /**
     * Recipients who introduced themselves after their row was written: pick the name up from the
     * rows that carry identity, keyed by the viewer key stored on the event.
     *
     * The key is normalised to **the person** on both sides, which is the whole difficulty. Inside
     * a data room a reading row is keyed `<digest>.<docId>` (`projectViewerKey` — one row per
     * document read behind one slug) while an arrival or an unlock is keyed by the bare digest,
     * because neither is about a document. Matching the two literally — which is what this did —
     * meant every project-link row stayed "Someone" for ever, however many times the reader gave
     * their name.
     */
    const viewerKeys = new Map<string, { shareId: string; botIdHash: string }>();
    for (const r of page) {
      if (!RECIPIENT_TYPES.has(r.type as string)) continue;
      const m = (r.meta ?? {}) as Record<string, unknown>;
      if (typeof m.viewerName === "string" && m.viewerName) continue;
      if (typeof m.viewerKey === "string" && m.viewerKey && typeof m.shareId === "string" && m.shareId) {
        const person = splitProjectViewerKey(m.viewerKey).botIdHash;
        if (person) viewerKeys.set(`${m.shareId}:${person}`, { shareId: m.shareId, botIdHash: person });
      }
    }
    /**
     * `{shareId, botIdHash}` for a document link, and the same digest with any document suffix for
     * a project one. The digest is hex, so it needs no escaping — but it is read off a stored
     * document, so anything that is not a digest falls back to an exact match rather than being
     * interpolated into a regex.
     */
    const viewerKeyClauses = Array.from(viewerKeys.values()).map(({ shareId, botIdHash }) => ({
      shareId,
      $or: viewerKeyMatchClause(botIdHash),
    }));

    const [users, docs, projects, knownViewers, knownLanders, plan] = await Promise.all([
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
        ? ShareViewModel.find({ $or: viewerKeyClauses })
            .select({ shareId: 1, botIdHash: 1, viewerName: 1, viewerEmail: 1, viewerEmailSnapshot: 1 })
            .lean()
        : Promise.resolve([]),
      // The arrival rows. A visitor who opens a data room and reads nothing writes no `ShareView`
      // at all, so this is the only place their name exists — and an arrival is exactly the row
      // that wants one.
      viewerKeys.size
        ? ProjectLinkViewModel.find({ $or: Array.from(viewerKeys.values()) })
            .select({ shareId: 1, botIdHash: 1, viewerName: 1, viewerEmail: 1, viewerEmailSnapshot: 1 })
            .lean()
        : Promise.resolve([]),
      getWorkspacePlan(orgId).catch(() => "free" as const),
    ]);
    const viewerByKey = new Map<string, { name: string | null; email: string | null }>();
    type KnownViewerRow = {
      shareId?: string;
      botIdHash?: string;
      viewerName?: string | null;
      viewerEmail?: string | null;
      viewerEmailSnapshot?: string | null;
    };
    // Arrivals first, readings second: both are indexed by the person, and a reading row is the
    // fresher of the two whenever a reader has both.
    for (const v of [...(knownLanders as KnownViewerRow[]), ...(knownViewers as KnownViewerRow[])]) {
      if (!v.shareId || !v.botIdHash) continue;
      const person = splitProjectViewerKey(v.botIdHash).botIdHash;
      if (!person) continue;
      const name = v.viewerName ?? null;
      const email = v.viewerEmail ?? v.viewerEmailSnapshot ?? null;
      if (!name && !email) continue;
      // Merged field by field, not replaced. The ingest writes `viewerEmail` independently of
      // `viewerName`, so an email-only reading row was overwriting a named arrival row and the
      // feed rendered the address where it already had the person's name.
      const key = `${v.shareId}:${person}`;
      const held = viewerByKey.get(key);
      viewerByKey.set(key, { name: name ?? held?.name ?? null, email: email ?? held?.email ?? null });
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
      const isRecipientRow = r.actorKind === "viewer" && RECIPIENT_TYPES.has(r.type as string);
      const hideIdentity = isRecipientRow && !showViewerIdentity;
      const uid = r.userId && !hideIdentity ? String(r.userId) : null;
      const u = uid ? userById.get(uid) ?? null : null;
      let meta = r.meta && typeof r.meta === "object" ? { ...(r.meta as Record<string, unknown>) } : {};
      /** Their metrics page, filled in below for recipient rows on a workspace that can see who they are. */
      let readerHref: string | null = null;
      if (isRecipientRow) {
        const known =
          typeof meta.viewerKey === "string" && typeof meta.shareId === "string"
            ? viewerByKey.get(`${meta.shareId}:${splitProjectViewerKey(meta.viewerKey).botIdHash}`)
            : undefined;
        if (known && !meta.viewerName) meta = { ...meta, viewerName: known.name, viewerEmail: meta.viewerEmail ?? known.email };
        // Behind the same gate as the name: on Free the row says "Someone", and a link to a reader
        // page that would identify them is the identity gate with an extra step.
        if (showViewerIdentity) {
          readerHref = readerHrefFor(String(r.type), meta, {
            userId: r.userId ? String(r.userId) : null,
            docId: r.docId ? String(r.docId) : null,
            projectId: r.projectId ? String(r.projectId) : null,
          });
        }
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
      /**
       * The contributor page for the member on this row, when the row is theirs to own.
       *
       * Built from `uid`, which is already null on a recipient row whose identity this workspace
       * may not see, so the Free identity gate blanks the link as well as the name: a key is an
       * addressable identity, and handing one out for a row whose name is withheld would be the
       * gate with an extra step.
       *
       * Withheld on viewer and secret rows on every plan, which is the same exclusion
       * `buildActorFilter` applies to a person: those rows are not that person's work in the
       * workspace, so the page this would point at does not list them, and on a recipient it is
       * the wrong page entirely (theirs is `readerHref`).
       */
      const actorKeyForRow = uid && r.actorKind !== "viewer" && r.actorKind !== "secret" ? personKey(uid) : null;
      const agentKeyForRow = agent ? agentKey(agent.client, uid) : null;
      const createdDate = r.createdDate instanceof Date ? r.createdDate : new Date(String(r.createdDate));
      // Events whose `title` is the PROJECT's name rather than a document's, so the fallback used
      // when the project row is gone names the right thing.
      const isProjectEvent = r.type === "request_repo.created" || r.type === "project.landed";

      return {
        id: String(r._id),
        type: r.type,
        createdDate: createdDate.toISOString(),
        actor: {
          userId: uid,
          name: u?.name ?? null,
          email: u?.email ?? null,
          kind: r.actorKind,
          key: actorKeyForRow,
          href: actorKeyForRow ? contributorHref(actorKeyForRow) : null,
        },
        agent: agent
          ? {
              client: agent.client,
              label: agentLabel(agent) ?? agent.client,
              version: agent.version,
              key: agentKeyForRow,
              href: agentKeyForRow ? contributorHref(agentKeyForRow) : null,
              ownerUserId: uid,
            }
          : null,
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
        readerHref,
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
    return errorJson(err, { status: 500, publicMessage: "Could not load activity", context: "[api/activity] GET failed" });
  }
}
