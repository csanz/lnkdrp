/**
 * API route for `/api/contacts/export`.
 *
 * - `GET` — the contacts list as a CSV attachment, taking the same filters and sort as
 *   `/api/contacts` so "Download CSV" hands you exactly the rows on screen, not the whole
 *   workspace with the filter forgotten.
 *
 * The file is named after the workspace and the day (`contacts-<slug>-<yyyymmdd>.csv`), because
 * a folder of three `contacts.csv` from three raises is three identical names. Identity follows
 * the plan the same way the list does: on Free, a contact who never introduced themselves is a
 * row with an empty name and email, never a row that is missing.
 *
 * It streams, and it counts first. Streaming keeps a long list out of the server's memory and
 * starts the browser's file while the database is still reading. Counting first is what makes the
 * cap honest: past `CONTACTS_CSV_MAX_ROWS` this answers 413 and says how many there are, because
 * a download that has already begun cannot be told it is going to be short.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { errorJson } from "@/lib/http/errorResponse";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import {
  contactIdentityAllowed,
  contactsCsvChunks,
  CONTACTS_CSV_MAX_ROWS,
  countContacts,
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

/** The same parse as `/api/contacts`: a download must carry the filter it was asked with. */
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

/** `yyyymmdd` in UTC, for the attachment name. */
function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, "");
}

/** The workspace's slug when it has one (team workspaces), else its id, kept to filename-safe characters. */
async function workspaceLabel(orgId: string): Promise<string> {
  try {
    await connectMongo();
    const org = await OrgModel.findById(orgId).select("slug").lean();
    const slug = org && typeof org.slug === "string" ? org.slug.trim().toLowerCase() : "";
    const safe = slug.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    return safe || orgId;
  } catch {
    return orgId;
  }
}

/** The filtered contacts list as a CSV download. */
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
      const requestedAt = new Date();
      const [identity, label, total] = await Promise.all([
        contactIdentityAllowed(actor.orgId),
        workspaceLabel(actor.orgId),
        countContacts({ orgId: actor.orgId, ...parsed.filters }),
      ]);
      // Counted before a single byte goes out, because a download is a 200 the moment it starts:
      // there is no way to tell someone half way through a file that the rest of their list is
      // missing. Over the cap the answer is a refusal that names the number and asks for a
      // narrower filter, which is honest, rather than a file that is quietly short.
      if (total > CONTACTS_CSV_MAX_ROWS) {
        return applyTempUserHeaders(
          NextResponse.json(
            {
              error: `That is ${total.toLocaleString("en-US")} contacts, and a download holds ${CONTACTS_CSV_MAX_ROWS.toLocaleString("en-US")}. Narrow it with a search, a tag or a date and try again.`,
              total,
              max: CONTACTS_CSV_MAX_ROWS,
            },
            { status: 413, headers: NO_STORE },
          ),
          actor,
        );
      }
      const filename = `contacts-${label}-${dayStamp(requestedAt)}.csv`;
      // Streamed a batch at a time: the browser starts writing the file while the database is
      // still reading, and nothing holds the whole list in memory. The BOM is for Excel, which
      // reads a UTF-8 file without one as the local code page and turns a name like Renee's into
      // mojibake.
      const chunks = contactsCsvChunks({ orgId: actor.orgId, identity, ...parsed.filters, sort: parsed.sort, dir: parsed.dir });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("﻿"));
        },
        async pull(controller) {
          try {
            const next = await chunks.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          } catch (err) {
            controller.error(err);
          }
        },
        cancel() {
          void chunks.return(undefined);
        },
      });
      return applyTempUserHeaders(
        new NextResponse(body, {
          status: 200,
          headers: {
            ...NO_STORE,
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
          },
        }),
        actor,
      );
    } catch (err) {
      return applyTempUserHeaders(
        errorJson(err, { status: 500, publicMessage: "Could not export contacts", context: "[api/contacts/export] GET failed" }),
        actor,
      );
    }
  });
}
