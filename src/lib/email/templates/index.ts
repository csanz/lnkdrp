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
export * from "./memberRemoved";
export * from "./waitlistApproved";
export * from "./welcome";
export * from "./orgInvite";
export * from "./viewerIntroduction";

export { EMAIL_CATALOG } from "../catalog";
