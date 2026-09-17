/**
 * Every email lnkdrp sends, in one place.
 *
 * Each template is a pure function returning `{ subject, text }` (and `html` when it has one), so a
 * body can be read, tested and changed without going through the route or job that sends it. Senders
 * stay where they are (`sendTextEmail`, `sendOrgInviteEmail`, `sendPlanLimitEmail`, and
 * `sendNotificationEmails` for the digests); templates only build the content.
 *
 * Adding an email: put its builder in a file here, export it below, and add its row to
 * `EMAIL_CATALOG` so the list of what we send stays honest.
 */
export * from "./signature";
export * from "./downloadRequest";

/** One row per email we send: for docs, for support ("which email is this?"), and for review. */
export const EMAIL_CATALOG: readonly {
  id: string;
  what: string;
  to: "owner" | "member" | "requester" | "invitee";
  builtBy: string;
}[] = [
  { id: "download_request.received", what: "Receipt to the person who asked to download a PDF", to: "requester", builtBy: "templates/downloadRequest.ts" },
  { id: "download_request.owner", what: "Asks the owner to approve or deny a download request", to: "owner", builtBy: "templates/downloadRequest.ts" },
  { id: "download_request.approved", what: "Tells the requester their download was approved", to: "requester", builtBy: "templates/downloadRequest.ts" },
  { id: "org_invite", what: "Invites someone to a workspace", to: "invitee", builtBy: "email/sendOrgInviteEmail.ts" },
  { id: "plan_limit", what: "A Free workspace is over a plan limit (grace, then blocked)", to: "owner", builtBy: "email/sendPlanLimitEmail.ts" },
  { id: "share_views.immediate", what: "A recipient opened a share link", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "share_views.daily", what: "Daily digest of recipient opens", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "doc_update.immediate", what: "A document was replaced and what changed", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "doc_update.daily", what: "Daily digest of document updates", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "repo_link_request.immediate", what: "A repository link was requested or needs review (request repos, behind a flag)", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "repo_link_request.daily", what: "Daily digest of repository link requests", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
];
