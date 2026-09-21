/**
 * "You're invited to join a workspace."
 *
 * Sent by the invite route when someone is added to an org they are not yet in. The link is the
 * whole point of the mail, so it is a button rather than a line of text among others.
 *
 * The role is shown because it is the one thing the recipient cannot work out from the app once
 * they arrive — whether they were added to look or to edit.
 */
import { blocks, transactional, type EmailContent } from "./compose";

export function orgInviteEmail(params: {
  orgName: string;
  inviteUrl: string;
  role: string;
  /** Who sent it, when we know; an invite from nobody reads like phishing. */
  invitedByEmail?: string | null;
}): EmailContent {
  const workspace = (params.orgName ?? "").trim() || "a workspace";
  const invitedBy = (params.invitedByEmail ?? "").trim();
  const role = (params.role ?? "").trim();

  return transactional({
    subject: `You're invited to join ${workspace}`,
    preheader: invitedBy ? `${invitedBy} added you.` : "Open the link to join.",
    blocks: blocks(
      { kind: "heading", text: `You're invited to ${workspace}` },
      { kind: "p", text: "Someone added you to their LinkDrop workspace." },
      {
        kind: "rows",
        rows: [
          ...(role ? ([["Role", role]] as Array<[string, string]>) : []),
          ...(invitedBy ? ([["Invited by", invitedBy]] as Array<[string, string]>) : []),
        ],
      },
      { kind: "action", label: "Join", url: params.inviteUrl },
    ),
  });
}
