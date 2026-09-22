/**
 * The workspace behind an email, resolved from an org id.
 *
 * Owner-facing mail needs this to disambiguate — somebody in two workspaces cannot tell which
 * "2 people opened Series A deck" belongs to. Reader-facing mail needs it for the opposite reason:
 * the reader has never heard of LinkDrop, and the name they recognise is the one that shared the
 * document with them.
 *
 * Always best-effort. Every caller here is sending mail that matters more than its own header, so
 * a lookup failure returns `null` and the email goes out without the name rather than not at all.
 * The notification cron does not use this — it resolves the same fields inside its own per-run
 * memo, because it sends to many members of one workspace and would otherwise repeat the query
 * once per recipient.
 */
import { Types } from "mongoose";

import type { EmailWorkspace } from "@/lib/email/layout";
import { OrgModel } from "@/lib/models/Org";

export async function workspaceForEmail(
  orgId: Types.ObjectId | string | null | undefined,
): Promise<EmailWorkspace | null> {
  const id = orgId ? String(orgId) : "";
  if (!id || !Types.ObjectId.isValid(id)) return null;
  try {
    const org = (await OrgModel.findById(new Types.ObjectId(id)).select({ name: 1, avatarUrl: 1 }).lean()) as
      | { name?: unknown; avatarUrl?: unknown }
      | null;
    const name = typeof org?.name === "string" ? org.name.trim() : "";
    if (!name) return null;
    const avatar = typeof org?.avatarUrl === "string" ? org.avatarUrl.trim() : "";
    return { name, avatarUrl: avatar || null };
  } catch {
    return null;
  }
}

/** When the caller already has the name but not the avatar — `viewer_verify` and `org_invite`. */
export function workspaceFromName(name: string | null | undefined): EmailWorkspace | null {
  const value = (name ?? "").trim();
  return value ? { name: value, avatarUrl: null } : null;
}
