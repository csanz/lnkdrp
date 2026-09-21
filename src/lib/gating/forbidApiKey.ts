/**
 * Actions an API key may never perform, however well-scoped it is.
 *
 * A `lnk_` key is a delegated capability for **document work**: create links, read stats, replace a
 * PDF, file something in a project. That is what an agent needs and what the MCP server exposes.
 * It is not a second password for the account that issued it.
 *
 * The distinction was not enforced, and the gap was self-perpetuating: a key could mint new keys
 * and revoke existing ones, so revoking a leaked key did not end the compromise — the attacker had
 * already issued themselves another. It could also email an admin invite, planting a human
 * collaborator who survives every key being revoked; remove members; delete the workspace; and
 * delete the owner's entire account. All of that from a string in a config file on a laptop.
 *
 * The rule, stated once: **keys do document work, not identity work and not money.** Anything that
 * changes who has access, who exists, or who is billed requires a person who signed in.
 *
 * `requireAdmin` already refuses key actors for the staff area (`src/lib/gating/requireAdmin.ts`);
 * this is the same idea for the tenant-facing routes that are equally identity-grade.
 */
import { NextResponse } from "next/server";

import type { Actor } from "@/lib/gating/actor";

/**
 * A 403 when this actor came from an API key, or null to continue.
 *
 * Deliberately a returned response rather than a thrown error: these routes already have their own
 * error shapes and status conventions, and a guard that throws would be routed through whichever
 * catch happened to be nearest.
 *
 * @param what - names the action in the message, e.g. "delete an account". An agent that is told
 *   only "forbidden" will retry; one told which action is off-limits can tell its human.
 */
export function forbidApiKey(actor: Actor, what: string): NextResponse | null {
  if (actor.kind !== "user" || !actor.viaApiKey) return null;
  return NextResponse.json(
    {
      error: "api_key_forbidden",
      message: `An API key cannot ${what}. Sign in and do it from the app.`,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
