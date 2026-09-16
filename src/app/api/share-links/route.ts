/**
 * API route for `/api/share-links`.
 *
 * Workspace-wide full-text search over share links by label/audience (mt_9ceLy7DqEr) — the
 * counterpart to `GET /api/docs?q=`, which only ever matched a document's title or the random
 * public slug of one of its links. Neither route could answer "find the a16z link" without already
 * knowing which document it lives on; this one exists specifically for that case. `GET
 * /api/docs/:docId/links?q=` (added alongside this) is the scoped version once the document is
 * already known.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { searchShareLinks } from "@/lib/share/links";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/share-links?q=&limit=`
 *
 * `q` (required, non-empty) full-text searches `label`/`audience` across every link in the
 * workspace, ranked by relevance (`sharelinks`'s text index; whole-word matches, not substrings —
 * see the index for why). `limit` 1-50, default 20. Readable by any member (viewers included),
 * same as every other read here.
 * Out: `{ query, links: [{ docId, docTitle, docShareId, linkId, shareId, label, audience,
 * isDefault }] }`, deleted and archived documents' links excluded.
 */
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    if (!Types.ObjectId.isValid(actor.orgId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid org" }, { status: 400 }), actor);
    }
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") ?? "").trim();
    if (!query) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing q" }, { status: 400 }), actor);
    }
    const limitParam = Number(params.get("limit"));
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, Math.floor(limitParam))) : 20;

    const links = await searchShareLinks({ orgId: actor.orgId, query, limit });
    return applyTempUserHeaders(NextResponse.json({ query, links }, { headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not search share links", context: "[api/share-links] GET failed" });
  }
}
