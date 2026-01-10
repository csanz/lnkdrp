type SendTextEmailParams = {
  to: string;
  subject: string;
  text: string;
  /**
   * Optional override for From.
   * If omitted, uses `NOTIFICATION_EMAIL_FROM` or falls back to `INVITE_EMAIL_FROM`.
   */
  from?: string | null;
};

/**
 * Email helper: send a plain text email.
 *
 * Supports a safe local/dev mode:
 * - `EMAIL_TRANSPORT=console` will log the payload instead of sending (no API keys needed).
 *
 * Production sending uses Resend's HTTP API (`RESEND_API_KEY`).
 */
export async function sendTextEmail(params: SendTextEmailParams): Promise<void> {
  const { to, subject, text } = params;

  const transport = (process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  if (transport === "console") {
    // eslint-disable-next-line no-console
    console.log("[email:console]", { to, subject, text });
    return;
  }

  const apiKey = mustGetEnv("RESEND_API_KEY");
  const from =
    (params.from ?? null)?.trim() ||
    (process.env.NOTIFICATION_EMAIL_FROM ?? "").trim() ||
    (process.env.INVITE_EMAIL_FROM ?? "").trim() ||
    mustGetEnv("INVITE_EMAIL_FROM");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to send email (${res.status}): ${body || res.statusText}`);
  }
}

/** Return an environment variable or throw with a clear configuration error. */
function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

