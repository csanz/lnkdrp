/**
 * API route for `/api/users/me/name` — update the signed-in user's display name.
 */
import { NextResponse } from "next/server";
import { errorJson } from "@/lib/http/errorResponse";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function asTrimmedString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  return s;
}

function buildFullName(firstName: string, lastName: string | null): string {
  const first = firstName.trim();
  const last = (lastName ?? "").trim();
  return last ? `${first} ${last}` : first;
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Identity-grade, and the sweep that closed account delete, member removal, invites and key
    // minting missed this route. `resolveActor` accepts an `lnk_` bearer, so a key minted for one
    // workspace was rewriting `User.name`, which is the account row and not a workspace row. A
    // reader would have assumed the name is workspace-local because the key is pinned to one
    // orgId; it is not. It is what every workspace the person belongs to renders in its member
    // list, what the member.joined and member.removed activity rows copy in, and what outgoing
    // email signs. The workspace avatar already makes the same call for the narrower case:
    // branding is identity work, not document work. Refusing here, before the body is parsed, is
    // deliberate: an empty POST from a key used to answer 400 "Missing firstName", which reads as
    // a rejection but means the key authenticated and the write was one field away.
    const keyRefusal = forbidApiKey(actor, "change your account name");
    if (keyRefusal) return keyRefusal;
    if (!Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Invalid actor" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as unknown as {
      firstName?: unknown;
      lastName?: unknown;
    };

    const firstName = asTrimmedString(body.firstName, 60);
    const lastNameRaw = body.lastName;
    const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";

    if (!firstName) {
      return NextResponse.json({ error: "Missing firstName" }, { status: 400 });
    }
    if (lastName.length > 60) {
      return NextResponse.json({ error: "Invalid lastName" }, { status: 400 });
    }

    const name = buildFullName(firstName, lastName || null);
    if (name.length > 120) {
      return NextResponse.json({ error: "Name too long" }, { status: 400 });
    }

    await connectMongo();
    await UserModel.updateOne({ _id: new Types.ObjectId(actor.userId) }, { $set: { name } });

    return NextResponse.json({ ok: true, name });
  } catch (err) {
    // A caught failure here is ours, not the caller's: the raw message went straight to the
    // browser (Mongo and Stripe internals included) and nothing reached the logs. `errorJson`
    // redacts, logs one line always, and keeps `detail` for non-production.
    return errorJson(err, { status: 500, publicMessage: "Could not save your name.", context: "[api/users/me/name] request failed" });
  }
}


