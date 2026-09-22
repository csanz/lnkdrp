/**
 * What to call each email on the Notifications page, and why it is or is not yours to change.
 *
 * The page used to show two dropdowns and nothing else, which made it a liar by omission: we send
 * a dozen kinds of email and it accounted for two of them. Somebody reading it had no way to learn
 * what else arrives, let alone why they could not switch it off.
 *
 * The honest fix is not more switches. Most of these are transactional — one email, caused by one
 * action — and a setting that suppresses "you were removed from Acme" or "new documents are paused
 * on this workspace" means somebody loses access or gets blocked with no idea why. What was
 * missing is the list itself, and a straight answer for each entry.
 *
 * Keyed by `EMAIL_CATALOG.id`, and a test fails when the catalogue grows a row this file has not
 * described — the same guard `emailsAdmin.ts` uses, for the same reason: a registry of what we send
 * is only worth having while it is complete.
 */

export type EmailAudience =
  /** Arrives in the inbox of the person reading this page. */
  | "you"
  /** Goes to a reader, a requester or an invitee — someone on the other side of a share. */
  | "others";

export type EmailCopy = {
  /** What to call it in a list, in the reader's language rather than ours. */
  label: string;
  /** One sentence: what causes it. */
  when: string;
  audience: EmailAudience;
  /**
   * The preference that governs it, or `null` when it is transactional.
   *
   * `null` is a claim that needs justifying, so `why` says why for every one of them.
   */
  setting: "views" | "docUpdates" | "docUploads" | "repoRequests" | null;
  /** Why there is no switch. Required whenever `setting` is null. */
  why?: string;
  /** Hidden until the feature that sends it is switched on. */
  flagged?: boolean;
};

export const EMAIL_COPY: Record<string, EmailCopy> = {
  welcome: {
    label: "Welcome",
    when: "Once, when you create your account.",
    audience: "you",
    setting: null,
    why: "Sent a single time, and never again.",
  },
  waitlist_approved: {
    label: "Early access opened",
    when: "When your place in the queue comes up and the account opens.",
    audience: "you",
    setting: null,
    why: "Sent once. It is the email that tells you the door is open.",
  },
  member_removed: {
    label: "Removed from a workspace",
    when: "When someone removes your access to a workspace.",
    audience: "you",
    setting: null,
    why: "Losing access without being told means finding out from a page that suddenly shows nothing.",
  },
  plan_limit: {
    label: "Over the plan limits",
    when: "When a Free workspace goes over a limit, again partway through the grace period, and when it ends.",
    audience: "you",
    setting: null,
    why: "It warns that sharing new documents is about to stop. Muting it would turn a warning into a surprise.",
  },
  "download_request.owner": {
    label: "Someone wants to download",
    when: "When a reader asks for the file on a link that has downloads switched off.",
    audience: "you",
    setting: null,
    why: "It is a request waiting on your answer — approve or deny — not a notification about something already done.",
  },
  viewer_introduced: {
    label: "A reader said who they are",
    when: "When a reader you were emailed about anonymously comes back and gives their name.",
    audience: "you",
    setting: null,
    why:
      "It corrects an email you already have. It only goes to people who received that first one, so turning link-open emails off stops this too.",
  },
  "share_views.immediate": {
    label: "When someone opens a link",
    when: "When a recipient opens one of this workspace's share links.",
    audience: "you",
    setting: "views",
  },
  "share_views.daily": {
    label: "When someone opens a link — daily digest",
    when: "One email at the end of the day, covering every reader since the last.",
    audience: "you",
    setting: "views",
  },
  "doc_upload.immediate": {
    label: "A teammate added a document",
    when: "When someone else in this workspace uploads a new document. Never for your own uploads.",
    audience: "you",
    setting: "docUploads",
  },
  "doc_upload.daily": {
    label: "Documents teammates added — daily digest",
    when: "One email at the end of the day listing what your teammates added since the last.",
    audience: "you",
    setting: "docUploads",
  },
  "doc_update.immediate": {
    label: "A document was replaced",
    when: "When someone uploads a new version and the comparison finds real changes.",
    audience: "you",
    setting: "docUpdates",
  },
  "doc_update.daily": {
    label: "Documents replaced — daily digest",
    when: "One email at the end of the day listing every document replaced since the last.",
    audience: "you",
    setting: "docUpdates",
  },
  "repo_link_request.immediate": {
    label: "A repository link was requested",
    when: "When someone asks for a repository link, or one needs review.",
    audience: "you",
    setting: "repoRequests",
    flagged: true,
  },
  "repo_link_request.daily": {
    label: "Repository link requests — daily digest",
    when: "One email at the end of the day covering every request since the last.",
    audience: "you",
    setting: "repoRequests",
    flagged: true,
  },
  org_invite: {
    label: "Workspace invitation",
    when: "When you invite someone to this workspace.",
    audience: "others",
    setting: null,
    why: "It carries the join link. Without it the invitation does not exist.",
  },
  viewer_verify: {
    label: "Reader confirms their address",
    when: "When a reader introduces themselves on one of your links.",
    audience: "others",
    setting: null,
    why: "Sent to the reader, so their name reaches you instead of “Someone”. It gates nothing.",
  },
  "download_request.received": {
    label: "Download request received",
    when: "To whoever asked, confirming their request reached you.",
    audience: "others",
    setting: null,
    why: "A receipt. Without it the reader cannot tell whether anything happened.",
  },
  "download_request.approved": {
    label: "Download approved",
    when: "To whoever asked, once you approve it.",
    audience: "others",
    setting: null,
    why: "It carries the download link, which is the whole point of approving.",
  },
};
