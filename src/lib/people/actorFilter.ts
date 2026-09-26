/**
 * The Mongo clauses that mean "this one contributor", for the feed and for the profile.
 *
 * It exists so that a person's page and the feed's `who=me` cannot come to different conclusions
 * about what a person did. They are the same question asked by two surfaces, and when the feed's
 * three clauses lived only inside `GET /api/activity` the second surface was going to re-derive
 * them and get one wrong: the easy mistake is to match `userId` alone, which sweeps in every row
 * the person's agents wrote under their credential and prints an agent's filing on a colleague's
 * page. `src/lib/people/actorFilter.test.ts` pins the person branch against the route's `who=me`.
 *
 * Server-only (it builds ObjectIds); the parsing and formatting half is `./contributorKey`.
 */
import { Types } from "mongoose";

import type { ContributorKey } from "./contributorKey";

/**
 * Clauses selecting exactly this contributor's rows, to spread into a feed or aggregate match.
 *
 * Person: their own actions in the app. `agent.client: {$exists: false}` is what separates a person
 * from their agents (rows with no `agent` store it as null, so the subdocument's `client` path is
 * absent, not null), and the `actorKind` exclusion keeps out the rows where this member was the
 * *recipient* rather than the actor. That second clause is also why the actor filter can never be
 * turned into a way to read a signed-in recipient's own history: viewer-kind rows are excluded by
 * construction, on every plan, before any gating question is asked.
 *
 * Agent: rows carrying this client under this owner. Grouping on the pair rather than the client
 * alone is the point of the key: two members who each connect Claude Code are two contributors.
 * The unknown owner is a real selection (`userId: null`), not a wildcard, so it lists the rows of
 * credentials whose creator was never recorded rather than every owner's rows at once.
 */
export function buildActorFilter(key: ContributorKey): Record<string, unknown> {
  if (key.kind === "person") {
    return {
      userId: new Types.ObjectId(key.userId),
      "agent.client": { $exists: false },
      actorKind: { $nin: ["viewer", "secret"] },
    };
  }
  return {
    userId: key.ownerUserId ? new Types.ObjectId(key.ownerUserId) : null,
    "agent.client": key.client,
  };
}
