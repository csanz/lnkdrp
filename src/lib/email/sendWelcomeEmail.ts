/**
 * Sends the welcome email, and swallows every way that can go wrong.
 *
 * This is called from the NextAuth `signIn` callback, where a thrown error does not mean "no email"
 * — it means **the sign-in fails**. A person creating their account would be bounced to an
 * OAuth error page because a mail API had a bad minute. So nothing here is allowed to escape.
 *
 * It is awaited rather than left floating on purpose. On Vercel the function can be frozen the
 * moment the response is returned, and a detached promise is simply lost — which for a once-per-
 * account email means it is lost for good, with nothing to retry it. The cost is a few hundred
 * milliseconds, once, on the first sign-in an account ever makes.
 */
import { welcomeEmail } from "@/lib/email/templates/welcome";
import { sendTextEmail } from "@/lib/email/sendTextEmail";

export async function sendWelcomeEmail(params: { to: string; name?: string | null }): Promise<void> {
  try {
    const { subject, text } = welcomeEmail({ name: params.name ?? null });
    await sendTextEmail({ to: params.to, subject, text });
  } catch (err) {
    // Logged, not rethrown: see above. The account still exists and they are still signed in.
    // eslint-disable-next-line no-console
    console.error("[welcome-email] send failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
