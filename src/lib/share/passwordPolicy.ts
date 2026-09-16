/**
 * The one share-password length rule, shared by every surface that enforces it.
 *
 * It lived in four hardcoded copies (the link service, the doc-level share-password route, the
 * edit modal, and the MCP zod schemas), which is how they drifted apart without anyone noticing.
 * This module has no server-only imports on purpose, so the client modal can read it too.
 *
 * The minimum is 1, not 8. A share password is the sender's choice of how much friction to put in
 * front of a recipient they already trust, not a credential protecting an account: "jeff" for Jeff
 * is a legitimate thing to want. Brute force is bounded server-side regardless - the unlock route
 * allows 10 attempts per IP per share per 5 minutes. An empty string still means "no password".
 */
export const SHARE_PASSWORD_MIN = 1;
export const SHARE_PASSWORD_MAX = 128;

/** How the range reads in user- and agent-facing copy, e.g. "1-128 chars". */
export const SHARE_PASSWORD_RANGE_TEXT = `${SHARE_PASSWORD_MIN}-${SHARE_PASSWORD_MAX}`;
