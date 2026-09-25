/**
 * `POST /api/funnel`: the browser reporting an upgrade-funnel step.
 *
 * The server sees the 402s (`planLimitResponse` writes `plan.limit_reached`) and the Checkout
 * sessions (`checkout.started`), but not what happened in between: whether the upgrade modal was
 * shown for that refusal, and whether the person pressed Upgrade, chose a pack, compared plans, or
 * closed it. Those two moments are the funnel's middle, and only the browser knows them. This
 * route writes them as activity rows (`funnel.modal_shown`, `funnel.cta_clicked`) so the admin
 * funnel can count workspaces at each step; the workspace feed hides them
 * (`src/lib/activity/feedVisibility.ts`). The Free analytics teaser reports itself the same way
 * (`funnel.teaser_shown`, with the viewer counts it showed), so the funnel page can say how much
 * a workspace was looking at when it did or did not upgrade (Phase 4.2).
 *
 * Body: `{ event: "modal_shown" | "cta_clicked" | "teaser_shown", reason?, cta?, from?,
 * uniqueViewers?, identifiedViewers? }`. `reason` is the upsell key or out-of-credits reason the
 * modal opened for, `from` the surface that opened it, `cta` what was pressed (required for
 * `cta_clicked`); the two counts are read for `teaser_shown` only. Signed-in members only: a temp
 * workspace has no funnel and an API key has no modal. Best-effort on the client side, so the
 * answer is a bare `{ ok }`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { recordActivity, type ActivityType } from "@/lib/activity/log";
import { resolveActor } from "@/lib/gating/actor";
import { rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { parseFunnelBody } from "@/lib/funnel/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per person: a modal opens a handful of times an hour, not sixty times a minute. */
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };


/** `POST /api/funnel`: record one funnel step for the signed-in member's active workspace. */
export async function POST(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || actor.viaApiKey) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!Types.ObjectId.isValid(actor.orgId) || !Types.ObjectId.isValid(actor.userId)) {
    return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  }
  const rl = await rateLimit({ key: `funnel:${actor.userId}`, ...RATE_LIMIT });
  if (!rl.ok) return rateLimitedResponse(rl);

  const body = parseFunnelBody(await request.json().catch(() => null));
  if (typeof body === "string") return NextResponse.json({ error: body }, { status: 400 });

  const type: ActivityType =
    body.event === "modal_shown" ? "funnel.modal_shown" : body.event === "teaser_shown" ? "funnel.teaser_shown" : "funnel.cta_clicked";
  void recordActivity({
    orgId: actor.orgId,
    userId: actor.userId,
    actorKind: "user",
    type,
    meta: {
      reason: body.reason,
      cta: body.cta,
      from: body.from,
      ...(body.event === "teaser_shown" ? { uniqueViewers: body.uniqueViewers, identifiedViewers: body.identifiedViewers } : {}),
    },
    request,
  });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
