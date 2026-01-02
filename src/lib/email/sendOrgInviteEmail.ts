type SendOrgInviteEmailParams = {
  to: string;
  orgName: string;
  inviteUrl: string;
  role: string;
  invitedByEmail?: string | null;
};

/**
 * Email helper: sends a workspace invite email with an org-join link.
 *
 * Uses Resend's HTTP API (`RESEND_API_KEY`).
 */

/** Return an environment variable or throw with a clear configuration error. */
function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export async function sendOrgInviteEmail(params: SendOrgInviteEmailParams): Promise<void> {
  const { to, orgName, inviteUrl, role, invitedByEmail } = params;

  const apiKey = mustGetEnv("RESEND_API_KEY");
  const from = mustGetEnv("INVITE_EMAIL_FROM");

  const subject = `You're invited to join ${orgName}`;
  const text = [
    `You're invited to join the workspace "${orgName}".`,
    "",
    `Role: ${role}`,
    "",
    invitedByEmail ? `Invited by: ${invitedByEmail}` : null,
    "",
    `Join: ${inviteUrl}`,
    "",
    "- LinkDrop",
  ]
    .filter(Boolean)
    .join("\n");

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


