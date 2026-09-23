/**
 * Every email lnkdrp sends, as data and nothing else.
 *
 * Deliberately free of imports, and deliberately not inside `templates/index.ts`.
 *
 * The barrel re-exports every builder, and those reach `planLimits` for the plan numbers, which
 * reaches `Org`, which reaches `OrgMembership` — a mongoose model. Importing the catalogue from a
 * browser component therefore pulled the whole server-side model layer into the bundle and threw
 * `Cannot read properties of undefined (reading 'OrgMembership')` at module evaluation, taking the
 * page down with it. That happened the day the Notifications page started listing these.
 *
 * A list of ids and one-line descriptions has no business depending on any of that. Keep this file
 * import-free so it stays safe to read from anywhere.
 */
export const EMAIL_CATALOG: readonly {
  id: string;
  what: string;
  to: "owner" | "member" | "requester" | "invitee" | "reader";
  builtBy: string;
}[] = [
  { id: "welcome", what: "Greets a brand-new account, once, at sign-up (never sent to a waitlisted signup)", to: "member", builtBy: "templates/welcome.ts" },
  { id: "download_request.received", what: "Receipt to the person who asked to download a PDF", to: "requester", builtBy: "templates/downloadRequest.ts" },
  { id: "download_request.owner", what: "Asks the owner to approve or deny a download request", to: "owner", builtBy: "templates/downloadRequest.ts" },
  { id: "download_request.approved", what: "Tells the requester their download was approved", to: "requester", builtBy: "templates/downloadRequest.ts" },
  { id: "member_removed", what: "Tells someone their access to a workspace was removed", to: "member", builtBy: "templates/memberRemoved.ts" },
  { id: "waitlist_approved", what: "Tells someone in the early-access queue that their account is open", to: "invitee", builtBy: "templates/waitlistApproved.ts" },
  { id: "viewer_verify", what: "Asks a reader who introduced themselves to confirm their address (never a gate)", to: "reader", builtBy: "templates/viewerIntroduction.ts" },
  { id: "viewer_introduced", what: "Tells the owner which reader was behind an anonymous open", to: "owner", builtBy: "templates/viewerIntroduction.ts" },
  { id: "org_invite", what: "Invites someone to a workspace", to: "invitee", builtBy: "templates/orgInvite.ts" },
  { id: "plan_limit", what: "A Free workspace is over a plan limit (grace, then blocked)", to: "owner", builtBy: "email/sendPlanLimitEmail.ts" },
  { id: "share_views.immediate", what: "A recipient opened a share link", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "share_views.daily", what: "Daily digest of recipient opens", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "visit_brief.immediate", what: "A recipient finished reading: the AI brief of their visit, or the facts of it", to: "member", builtBy: "notifications/visitBriefEmail.ts" },
  { id: "visit_brief.daily", what: "Daily digest of finished visits and their briefs", to: "member", builtBy: "notifications/visitBriefEmail.ts" },
  { id: "doc_upload.immediate", what: "A teammate added a new document to the workspace", to: "member", builtBy: "notifications/docUploadEmail.ts" },
  { id: "doc_upload.daily", what: "Daily digest of documents teammates added", to: "member", builtBy: "notifications/docUploadEmail.ts" },
  { id: "doc_update.immediate", what: "A document was replaced and what changed", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "doc_update.daily", what: "Daily digest of document updates", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "repo_link_request.immediate", what: "A repository link was requested or needs review (request repos, behind a flag)", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
  { id: "repo_link_request.daily", what: "Daily digest of repository link requests", to: "member", builtBy: "notifications/sendNotificationEmails.ts" },
];
