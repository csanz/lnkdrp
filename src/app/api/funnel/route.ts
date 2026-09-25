/**
 * `POST /api/funnel`: the browser reporting an upgrade-funnel step.
 *
 * The server sees the 402s (`planLimitResponse` writes `plan.limit_reached`) and the Checkout
 * sessions (`checkout.started`), but not what happened in between: whether the upgrade modal was
 * shown for that refusal, and whether the person pressed Upgrade, chose a pack, compared plans, or
 * closed it. Those two moments are the funnel's middle, and only the browser knows them. This
 * route writes them as activity rows (`funnel.modal_shown`, `funnel.cta_clicked`) so the admin
 * funnel can count workspaces at each step; the workspace feed hides them
 * (`src/lib/activity/feedVisibility.ts`).
 *
 * Body: `{ event: "modal_shown" | "cta_clicked", reason?, cta?, from? }`. `reason` is the upsell
 * key or out-of-credits reason the modal opened for, `from` the surface that opened it, `cta` what
 * was pressed (required for `cta_clicked`). Signed-in members only: a temp workspace has no funnel
 * and an API key has no modal. Best-effort on the client side, so the answer is a bare `{ ok }`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { recordActivity, type ActivityType } from "@/lib/activity/log";
import { resolveActor } from "@/lib/gating/actor";
import { rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Funnel steps the browser may report. */
export const FUNNEL_EVENTS = ["modal_shown", "cta_clicked"] as const;
/** What can be pressed on an upgrade or out-of-credits modal. */
export const FUNNEL_CTAS = ["upgrade", "pack", "compare", "manage", "dismiss"] as const;

/** A validated request body. */
export type FunnelBody = {
  event: (typeof FUNNEL_EVENTS)[number];
  reason: string | null;
  cta: (typeof FUNNEL_CTAS)[number] | null;
  from: string | null;
};

const TOKEN_RE = /^[a-z0-9_.-]{1,64}$/i;
/** Per person: a modal opens a handful of times an hour, not sixty times a minute. */
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Parse and validate the body; a string says what is wrong. */
export function parseFunnelBody(raw: unknown): FunnelBody | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object";
  const b = raw as Record<string, unknown>;
  const event = typeof b.event === "string" ? b.event : "";
  if (!(FUNNEL_EVENTS as readonly string[]).includes(event)) return `event must be one of ${FUNNEL_EVENTS.join(", ")}`;
  const token = (v: unknown, name: string): string | null | Error => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || !TOKEN_RE.test(v)) return new Error(`${name} must be a short token`);
    return v;
  };
  const reason = token(b.reason, "reason");
  if (reason instanceof Error) return reason.message;
  const from = token(b.from, "from");
  if (from instanceof Error) return from.message;
  const ctaRaw = b.cta === undefined || b.cta === null || b.cta === "" ? null : b.cta;
  if (ctaRaw !== null && !(FUNNEL_CTAS as readonly unknown[]).includes(ctaRaw)) return `cta must be one of ${FUNNEL_CTAS.join(", ")}`;
  const cta = ctaRaw as FunnelBody["cta"];
  if (event === "cta_clicked" && !cta) return "cta is required for cta_clicked";
  return { event: event as FunnelBody["event"], reason, cta, from };
}

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

  const type: ActivityType = body.event === "modal_shown" ? "funnel.modal_shown" : "funnel.cta_clicked";
  void recordActivity({
    orgId: actor.orgId,
    userId: actor.userId,
    actorKind: "user",
    type,
    meta: { reason: body.reason, cta: body.cta, from: body.from },
    request,
  });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
