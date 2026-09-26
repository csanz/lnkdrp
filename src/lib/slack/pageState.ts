/**
 * The Slack state for the signed-in person's active workspace, resolved on the server.
 *
 * Why a server read exists next to `GET /api/orgs/active/slack`: the integrations pages used to
 * ask the browser, and on every full reload the first paint had no answer, so the card guessed.
 * A guess that is wrong for a second ("Set up" over a connected channel) is a bug, and a neutral
 * word that flips a second later is still a flip. The server has the cookie and the database;
 * it answers before the first byte of HTML, and the client hook starts from that answer.
 *
 * `null` means "could not tell" (signed out, no workspace, a database blip): the client then
 * fetches as before and shows nothing definite until it hears back. Same membership rule as the
 * route, and no temp user is ever minted from here.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveExistingActor } from "@/lib/gating/actor";
import { serverComponentRequest } from "@/lib/gating/serverComponentRequest";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { slackEnabled } from "@/lib/slack/config";
import { listSlackConnections, serializeSlackConnection, type SlackState } from "@/lib/slack/connections";

/** The active workspace's Slack state for this request, or `null` when it cannot be known. */
export async function slackStateForPage(): Promise<SlackState | null> {
  try {
    // The actor resolvers read cookies from a `Request`; a server component has only headers and a
    // cookie jar, and NextAuth's `getToken` reads the jar and not the header — so the request has to
    // carry both or every signed-in visitor reads as signed out. See `serverComponentRequest`.
    const request = await serverComponentRequest("/integrations");
    const actor = await resolveExistingActor(request);
    if (!actor || actor.kind !== "user" || !Types.ObjectId.isValid(actor.orgId) || !Types.ObjectId.isValid(actor.userId)) return null;
    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const member = await OrgMembershipModel.exists({ orgId, userId: new Types.ObjectId(actor.userId), isDeleted: { $ne: true } });
    if (!member) return null;
    const rows = await listSlackConnections(orgId);
    return { enabled: slackEnabled(), connections: rows.map(serializeSlackConnection) };
  } catch {
    return null;
  }
}
