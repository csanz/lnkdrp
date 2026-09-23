/**
 * Server side of the Plain chat widget (https://www.plain.com/docs/product/channels/chat).
 *
 * Two environment variables:
 * - `NEXT_PUBLIC_PLAIN_CHAT_APP_ID`: the chat app from Plain → Settings → Chat. Unset, the widget
 *   is not mounted and every "Contact us" link falls back to `mailto:hi@lnkdrp.com`.
 * - `PLAIN_CHAT_SECRET`: the secret from the same page. It signs the signed-in user's email so
 *   Plain treats the chat as that customer without asking them to verify by code. Unset, the
 *   widget still works but every visitor goes through Plain's own email verification.
 *
 * The hash is HMAC-SHA256 of the email, hex, computed here and only here: Plain treats it as a
 * bearer credential for that customer, so the secret never reaches the browser. The hash itself
 * does reach the browser, for the one person whose session produced it, which is the same trust
 * as the session cookie that produced it.
 */
import { createHmac } from "node:crypto";

export type PlainChatCustomer = {
  email: string;
  emailHash: string;
  fullName: string | null;
  externalId: string;
};

/** The chat app id, or null when the widget is not configured. */
export function plainChatAppId(): string | null {
  const v = (process.env.NEXT_PUBLIC_PLAIN_CHAT_APP_ID ?? "").trim();
  return v || null;
}

/** Hex HMAC-SHA256 of the email with the chat secret; null when no secret is set. */
export function plainChatEmailHash(email: string): string | null {
  const secret = (process.env.PLAIN_CHAT_SECRET ?? "").trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * The customer details for a signed-in session, or null when the chat should stay anonymous:
 * no session, no email, or no secret to sign it with. Anonymous is safe: Plain then verifies the
 * visitor by emailed code before any thread is shown.
 */
export function plainChatCustomer(user: { id?: string | null; email?: string | null; name?: string | null } | null | undefined): PlainChatCustomer | null {
  const email = (user?.email ?? "").trim().toLowerCase();
  if (!email || !user?.id) return null;
  const emailHash = plainChatEmailHash(email);
  if (!emailHash) return null;
  const name = (user.name ?? "").trim();
  return { email, emailHash, fullName: name || null, externalId: user.id };
}
