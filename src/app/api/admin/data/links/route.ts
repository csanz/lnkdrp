/**
 * Admin API route: `GET /api/admin/data/links`
 *
 * Lists share links across every workspace (paged) for admin inspection. Read-only.
 *
 * A document owns many links now, each with its own label, audience, password, expiry and
 * counters, and none of that was reachable from the admin area. Rows carry only ids, so the
 * workspace name and the document/project name are resolved with one `$in` per collection over the
 * current page — never a lookup per row.
 *
 * Password material is never returned: `passwordHash` is selected only to answer "is one set?" and
 * the encrypted reveal copy (`passwordEnc*`) is not selected at all.
 *
 * Neither is the slug. That care over the password was undone by the column beside it: `shareId` is
 * the address of the customer's document, so `state=active&kind=doc&limit=200`, filtered to the
 * rows reporting no password, was a page of documents anyone on the staff could open — with the
 * reads landing in the owner's analytics as anonymous recipient views. A slug an admin was actually
 * given still works as a search term above; it just does not come back in the rows.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { OrgModel } from "@/lib/models/Org";
import { ProjectModel } from "@/lib/models/Project";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import {
  deriveLinkState,
  isAdminLinkStateFilter,
  linkStateFilterFragment,
  pickDocTitle,
  type AdminLinkStateFilter,
} from "@/lib/admin/linksAdmin";

export const runtime = "nodejs";

/** Hard ceiling on one page, so a hand-edited `limit` cannot ask for the whole collection. */
const MAX_LIMIT = 200;

/**
 * Parses a value into a positive integer (>= 1) or returns null.
 *
 * Duplicated from the other admin list routes, which each carry their own copy.
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/** Escapes a string for safe use inside a RegExp literal (search terms are user input). */
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read a stored value that should be a trimmed string, or null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Read a stored Date as an ISO string, or null when absent. */
function asIso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

/** Read a stored counter, treating a missing field as 0 rather than NaN. */
function asCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Collect the ObjectIds of one field across the page, deduped, for a single `$in` lookup. */
function idsOf(rows: Array<Record<string, unknown>>, field: string): Types.ObjectId[] {
  const seen = new Map<string, Types.ObjectId>();
  for (const row of rows) {
    const v = row[field];
    if (v instanceof Types.ObjectId) seen.set(String(v), v);
  }
  return [...seen.values()];
}

/**
 * `GET /api/admin/data/links`
 *
 * Returns a paginated list of share links, optionally filtered by free text (label, audience or
 * public slug), by state (`active | disabled | expired | archived | password`) and by kind
 * (`doc | project`). Requires admin role (except localhost in dev).
 * Errors: 400 for an unknown `state`/`kind`, 401/403 for auth/permission failures.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, MAX_LIMIT);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const q = (url.searchParams.get("q") ?? "").trim();
  const stateRaw = (url.searchParams.get("state") ?? "").trim();
  const kindRaw = (url.searchParams.get("kind") ?? "").trim(); // doc | project | ""
  const sortRaw = (url.searchParams.get("sort") ?? "").trim(); // createdDate | lastViewedAt | viewCount
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase(); // asc | desc

  if (!isAdminLinkStateFilter(stateRaw)) {
    return NextResponse.json(
      { error: "state must be one of: active | disabled | expired | archived | password" },
      { status: 400 },
    );
  }
  const state: AdminLinkStateFilter = stateRaw;

  await connectMongo();

  const now = new Date();
  // Each clause is its own fragment under `$and`: the "active" state and the free-text search both
  // carry an `$or`, and a bare merge would silently drop one of them.
  const and: Record<string, unknown>[] = [];

  if (kindRaw) {
    if (kindRaw !== "doc" && kindRaw !== "project") {
      return NextResponse.json({ error: "kind must be one of: doc | project" }, { status: 400 });
    }
    // Links written before project links existed have no `kind` at all and are all document links,
    // hence `$ne: "project"` rather than `kind: "doc"` (see DOC_LINK_FILTER on the model).
    and.push(kindRaw === "project" ? { kind: "project" } : { kind: { $ne: "project" } });
  }

  const stateFragment = linkStateFilterFragment(state, now);
  if (stateFragment) and.push(stateFragment);

  if (q) {
    // A regex rather than the `sharelinks_label_audience_text` index: that index tokenises whole
    // words only and does not cover `shareId`, and an admin looking a link up usually has a slug or
    // a fragment of a label. The `.limit()` below keeps the scan bounded.
    const rx = new RegExp(escapeRegex(q), "i");
    and.push({ $or: [{ label: rx }, { audience: rx }, { shareId: rx }] });
  }

  const filter: Record<string, unknown> = and.length ? { $and: and } : {};

  // None of these sorts is covered by an index on its own — every `sharelinks` index starts with
  // `orgId` or `projectId`, and this listing is workspace-wide on purpose. The page is bounded by
  // `limit`, the sort is not; it is the same trade the other admin list routes make.
  const sortField =
    sortRaw === "lastViewedAt" ? "lastViewedAt" : sortRaw === "viewCount" ? "viewCount" : "createdDate";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await ShareLinkModel.countDocuments(filter);
  const rows = await ShareLinkModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      orgId: 1,
      docId: 1,
      projectId: 1,
      kind: 1,
      label: 1,
      audience: 1,
      isDefault: 1,
      enabled: 1,
      disabledByDocSwitch: 1,
      allowDownload: 1,
      allowRevisionHistory: 1,
      expiresAt: 1,
      // Selected only to compute `hasPassword` below; the value never leaves this function, and the
      // decryptable copy (passwordEnc/Iv/Tag) and salt are deliberately not selected at all.
      passwordHash: 1,
      createdVia: 1,
      archivedAt: 1,
      lastViewedAt: 1,
      viewCount: 1,
      downloadCount: 1,
      createdDate: 1,
    })
    .lean();

  const plain = rows as unknown as Array<Record<string, unknown>>;

  const [orgs, docs, projects] = await Promise.all([
    OrgModel.find({ _id: { $in: idsOf(plain, "orgId") } })
      .select({ name: 1, type: 1 })
      .lean(),
    DocModel.find({ _id: { $in: idsOf(plain, "docId") } })
      .select({ title: 1, docName: 1, fileName: 1, isDeleted: 1 })
      .lean(),
    ProjectModel.find({ _id: { $in: idsOf(plain, "projectId") } })
      .select({ name: 1, isDeleted: 1 })
      .lean(),
  ]);

  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const docById = new Map(docs.map((d) => [String(d._id), d]));
  const projectById = new Map(projects.map((p) => [String(p._id), p]));

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    state: state || null,
    kind: kindRaw || null,
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
    links: plain.map((r) => {
      const workspaceId = r.orgId instanceof Types.ObjectId ? String(r.orgId) : null;
      const docId = r.docId instanceof Types.ObjectId ? String(r.docId) : null;
      const projectId = r.projectId instanceof Types.ObjectId ? String(r.projectId) : null;
      const org = workspaceId ? orgById.get(workspaceId) : null;
      const doc = docId ? docById.get(docId) : null;
      const project = projectId ? projectById.get(projectId) : null;

      return {
        id: String(r._id),
        kind: asString(r.kind) ?? "doc",
        label: asString(r.label),
        audience: asString(r.audience),
        isDefault: Boolean(r.isDefault),
        workspaceId,
        workspaceName: org ? asString((org as { name?: unknown }).name) : null,
        workspaceType: org ? asString((org as { type?: unknown }).type) : null,
        docId,
        // Null when the document row is gone (hard-deleted) — the page renders an em dash, and the
        // link still has its own analytics, so the row itself stays worth showing.
        docTitle: pickDocTitle(doc as { title?: string | null; docName?: string | null; fileName?: string | null } | null),
        docDeleted: doc ? Boolean((doc as { isDeleted?: unknown }).isDeleted) : null,
        projectId,
        projectName: project ? asString((project as { name?: unknown }).name) : null,
        projectDeleted: project ? Boolean((project as { isDeleted?: unknown }).isDeleted) : null,
        state: deriveLinkState(
          {
            enabled: r.enabled as boolean | undefined,
            archivedAt: r.archivedAt as Date | null | undefined,
            expiresAt: r.expiresAt as Date | null | undefined,
          },
          now,
        ),
        enabled: r.enabled !== false,
        disabledByDocSwitch: Boolean(r.disabledByDocSwitch),
        allowDownload: Boolean(r.allowDownload),
        allowRevisionHistory: Boolean(r.allowRevisionHistory),
        hasPassword: Boolean(asString(r.passwordHash)),
        expiresAt: asIso(r.expiresAt),
        archivedAt: asIso(r.archivedAt),
        createdVia: asString(r.createdVia),
        lastViewedAt: asIso(r.lastViewedAt),
        // The link's own counters. They drift from ShareView (the honest source), so the page
        // labels them as counters rather than as traffic.
        viewCount: asCount(r.viewCount),
        downloadCount: asCount(r.downloadCount),
        createdDate: asIso(r.createdDate),
      };
    }),
  });
}
