/**
 * Which version of the Terms and Privacy Policy is in force.
 *
 * Stored on a user when they accept (`User.termsAcceptedAt` / `termsVersion`), so that a later
 * change can tell who has seen which without comparing a date against a changelog nobody kept up.
 *
 * Bump it when the Terms or the Privacy Policy change in a way people should see again. Nothing
 * re-prompts automatically — that is deliberate, because a re-prompt is a product decision with a
 * date attached, not something a constant should trigger the moment it is edited.
 *
 * Client-safe: a plain string and two paths, no server imports.
 */
export const CURRENT_TERMS_VERSION = "2026-09-21";

/** Where the two documents live, for links that must not drift apart in three different files. */
export const TERMS_URL = "/tos";
export const PRIVACY_URL = "/privacy";
