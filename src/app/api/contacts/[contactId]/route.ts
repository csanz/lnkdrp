/**
 * API route for `/api/contacts/:contactId`.
 *
 * - `GET` — one contact in full: identity, the documents and projects they touched, every source
 *   they arrived through, and the team's note.
 * - `PATCH { note }` — replace the note. An empty string clears it. This is the only thing a
 *   person can change about a contact (docs/prds/lnkdrp-contacts.md, non-goals): the name and
 *   address are what the reader said, and the rest is what they did.
 *
 * Reading is open to any active member. Writing takes a member and refuses an API key: a note is
 * a person's judgement about another person, and an agent putting words in it would be the one
 * write the PRD's "agents read contacts, and only read" exists to stop. The note edit is the one
 * contact action that lands in Activity, so a teammate can see who wrote what about whom.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { errorJson } from "@/lib/http/errorResponse";
import { recordActivity } from "@/lib/activity/log";
import { contactIdentityAllowed, getContact, setContactNote } from "@/lib/contacts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The most a note may hold; the model caps the field at the same length. */
const NOTE_MAX = 2000;

type Ctx = { params: Promise<{ contactId: string }> };

/** One contact in full, redacted per the plan. */
export async function GET(request: Request, ctx: Ctx) {
  return withMongoRequestLogging(request, async () => {
    const { contactId } = await ctx.params;
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor, "viewer");
    if (forbidden) return forbidden;
    if (!Types.ObjectId.isValid(contactId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
    }

    try {
      const identity = await contactIdentityAllowed(actor.orgId);
      const contact = await getContact({ orgId: actor.orgId, contactId, identity, viewerUserId: actor.userId, request });
      if (!contact) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
      }
      return applyTempUserHeaders(NextResponse.json({ contact, identity }, { headers: NO_STORE }), actor);
    } catch (err) {
      return applyTempUserHeaders(
        errorJson(err, { status: 500, publicMessage: "Could not load the contact", context: "[api/contacts/:id] GET failed" }),
        actor,
      );
    }
  });
}

/** Replace the team's note on one contact (`""` clears it). */
export async function PATCH(request: Request, ctx: Ctx) {
  return withMongoRequestLogging(request, async () => {
    const { contactId } = await ctx.params;
    const actor = await resolveActor(request);
    // Before anything else, the body included: a key that gets 400 learned it was one field away.
    const keyRefusal = forbidApiKey(actor, "write a contact note");
    if (keyRefusal) return keyRefusal;
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor, "member");
    if (forbidden) return forbidden;
    if (!Types.ObjectId.isValid(contactId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
    }

    try {
      const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
      if (typeof body?.note !== "string") {
        return applyTempUserHeaders(NextResponse.json({ error: "note must be a string" }, { status: 400, headers: NO_STORE }), actor);
      }
      const text = body.note.trim();
      if (text.length > NOTE_MAX) {
        return applyTempUserHeaders(
          NextResponse.json({ error: `A note holds up to ${NOTE_MAX} characters` }, { status: 400, headers: NO_STORE }),
          actor,
        );
      }

      const updated = await setContactNote({ orgId: actor.orgId, contactId, userId: actor.userId, text, viewerUserId: actor.userId, request });
      if (!updated) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
      }

      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: "user",
        type: "contact.note_updated",
        // The same shape the tag rows use, so one person reads the same way in both: `updated` is
        // the DTO `setContactNote` already redacted for this workspace's plan, so copying its
        // fields as they come is exactly "the name only when the list would show it anyway" — on
        // Pro, or for a contact who introduced themselves. Absent fields are omitted rather than
        // written as null, and the domain always rides along, so a redacted row reads "someone at
        // sequoiacap.com" instead of falling through to "a contact".
        meta: {
          contactId: updated.id,
          ...(updated.domain ? { contactDomain: updated.domain } : {}),
          ...(updated.name ? { contactName: updated.name } : {}),
          ...(updated.email ? { contactEmail: updated.email } : {}),
          cleared: text === "",
        },
        request,
      });

      // The service reads the contact back through the plan gate, so the response is redacted
      // exactly as a GET would be.
      return applyTempUserHeaders(NextResponse.json({ contact: updated }, { headers: NO_STORE }), actor);
    } catch (err) {
      return applyTempUserHeaders(
        errorJson(err, { status: 500, publicMessage: "Could not save the note", context: "[api/contacts/:id] PATCH failed" }),
        actor,
      );
    }
  });
}
