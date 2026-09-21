/**
 * "You were removed from a workspace."
 *
 * Losing access is otherwise something a person discovers from a page that suddenly shows nothing,
 * and the Remove dialog on the members tab promises this mail. Sent by
 * `POST /api/orgs/:orgId/members/:userId/revoke`, best-effort, after the membership is gone.
 *
 * Short on purpose. The one thing a reader actually wonders — "did my documents leave with me?" —
 * is answered in a sentence, and the rest (their account, their own workspace) in another. A
 * removal notice that reads like a policy page is worse, not kinder.
 */
import { blocks, transactional, type EmailContent } from "./compose";
import { getPublicSiteBase } from "@/lib/urls";

export function memberRemovedEmail(params: {
  orgName: string;
  /** Who removed them, when we know it; owners and admins are visible to members anyway. */
  removedByEmail?: string | null;
  /** Overrides the configured site URL, for tests and for callers that already resolved it. */
  appUrl?: string | null;
}): EmailContent {
  const workspace = (params.orgName ?? "").trim() || "a workspace";
  const removedBy = (params.removedByEmail ?? "").trim();
  // The same base every other link in every other email uses; the first version of this mail read
  // an env var nothing sets, so its one link silently never appeared.
  const base = (params.appUrl ?? getPublicSiteBase() ?? "").trim().replace(/\/+$/, "");

  return transactional({
    subject: `You were removed from ${workspace}`,
    preheader: "Your own account and personal workspace are unchanged.",
    blocks: blocks(
      { kind: "heading", text: `You were removed from ${workspace}` },
      { kind: "p", text: "You no longer have access to that workspace." },
      removedBy ? { kind: "rows", rows: [["Removed by", removedBy]] } : null,
      {
        kind: "p",
        text: "Anything you uploaded stays with the workspace and its links keep working. Your own account and personal workspace are unchanged.",
      },
      base ? { kind: "action", label: "Your workspace", url: base } : null,
    ),
  });
}
