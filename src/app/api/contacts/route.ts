/**
 * API route for `/api/contacts`.
 *
 * - `GET` — one page of the workspace's contacts: the people it has heard from, searched, filtered
 *   and sorted the way the Contacts page asks. Every filter is a query parameter so the page, the
 *   CSV export and the MCP list tool all describe the same slice with the same words.
 *
 * Any active member may read. Identity follows the plan (docs/prds/lnkdrp-contacts.md, decision
 * 4): the service redacts name and email on Free for anyone who did not introduce themselves, and
 * the response says so with `identity: false` so a client can explain the blanks instead of
 * drawing an empty column.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { errorJson } from "@/lib/http/errorResponse";
import {
  contactIdentityAllowed,
  listContacts,
  type ContactFilters,
  type ContactSort,
  type ContactSourceKind,
} from "@/lib/contacts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const SORTS: readonly ContactSort[] = ["lastSeen", "firstSeen", "name", "domain", "documentsRead", "visits"];
const SOURCES: readonly ContactSourceKind[] = ["introduced", "signed_in", "download_request", "request_upload"];
const ID_FILTERS = ["tagId", "docId", "projectId"] as const;

type ParsedQuery =
  | { ok: true; filters: ContactFilters; sort?: ContactSort; dir?: "asc" | "desc" }
  | { ok: false; error: string };

/**
 * The filter and sort parameters as the service wants them. Unknown sort or source values are
 * dropped rather than refused (a stale link still opens the page); a malformed id is refused,
 * because silently dropping it would answer the whole workspace to a request that asked for one
 * document's readers.
 */
function parseQuery(url: URL): ParsedQuery {
  const str = (key: string) => {
    const v = (url.searchParams.get(key) ?? "").trim();
    return v ? v.slice(0, 200) : undefined;
  };
  for (const key of ID_FILTERS) {
    const v = str(key);
    if (v && !Types.ObjectId.isValid(v)) return { ok: false, error: `Invalid ${key}` };
  }
  const sortRaw = str("sort");
  const dirRaw = str("dir");
  const sourceRaw = str("source");
  const filters: ContactFilters = {
    q: str("q"),
    tagId: str("tagId"),
    docId: str("docId"),
    projectId: str("projectId"),
    shareId: str("shareId"),
    domain: str("domain")?.toLowerCase(),
    source: SOURCES.includes(sourceRaw as ContactSourceKind) ? (sourceRaw as ContactSourceKind) : undefined,
  };
  return {
    ok: true,
    filters,
    sort: SORTS.includes(sortRaw as ContactSort) ? (sortRaw as ContactSort) : undefined,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : undefined,
  };
}

/** A positive integer from the query, or `undefined` so the service applies its default. */
function asPositiveInt(raw: string | null): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** One page of contacts with the plan's identity flag. */
export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor, "viewer");
    if (forbidden) return forbidden;

    try {
      const url = new URL(request.url);
      const parsed = parseQuery(url);
      if (!parsed.ok) {
        return applyTempUserHeaders(NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE }), actor);
      }
      const identity = await contactIdentityAllowed(actor.orgId);
      const result = await listContacts({
        orgId: actor.orgId,
        identity,
        viewerUserId: actor.userId,
        request,
        ...parsed.filters,
        sort: parsed.sort,
        dir: parsed.dir,
        page: asPositiveInt(url.searchParams.get("page")),
        limit: asPositiveInt(url.searchParams.get("limit")),
      });
      return applyTempUserHeaders(NextResponse.json({ ...result, identity }, { headers: NO_STORE }), actor);
    } catch (err) {
      return applyTempUserHeaders(
        errorJson(err, { status: 500, publicMessage: "Could not load contacts", context: "[api/contacts] GET failed" }),
        actor,
      );
    }
  });
}
