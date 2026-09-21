/**
 * `POST /api/users/me/first-run` — mark first-run setup as done for the signed-in user.
 *
 * Deliberately its own endpoint rather than a field on one of the three the welcome screen already
 * calls (`/api/users/me/name`, `/api/orgs/active/notification-preferences`, the org rename). Those
 * each own one setting and are used from the dashboard too; "I have seen the welcome screen" is
 * not a setting, and folding it into one of them would mean whichever call happened to be last
 * also decided whether the screen comes back.
 *
 * Idempotent, and called on **Skip** as well as on save: see `markFirstRunDone`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { errorJson } from "@/lib/http/errorResponse";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { markFirstRunDone } from "@/lib/onboarding/firstRun";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid actor" }, { status: 400 });
    await connectMongo();
    await markFirstRunDone(actor.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorJson(err, {
      context: "[api/users/me/first-run] failed",
      status: 500,
      publicMessage: "Could not save",
    });
  }
}
