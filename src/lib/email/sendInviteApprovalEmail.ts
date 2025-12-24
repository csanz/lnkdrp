type SendInviteApprovalEmailParams = {
  to: string;
  inviteCode: string;
  description?: string | null;
};

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function getPublicBaseUrl(): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  return base;
}

export async function sendInviteApprovalEmail(params: SendInviteApprovalEmailParams) {
  const { to, inviteCode, description } = params;

  const apiKey = mustGetEnv("RESEND_API_KEY");
  const from = mustGetEnv("INVITE_EMAIL_FROM");

  const base = getPublicBaseUrl();
  const homeUrl = base ? `${base}/` : "";
  const claimUrl = base ? `${base}/?invite=${encodeURIComponent(inviteCode)}` : "";

  const subject = "Your LinkDrop invite code";
  const text = [
    "You're approved to use LinkDrop.",
    "",
    `Invite code: ${inviteCode}`,
    claimUrl
      ? `Click to use it: ${claimUrl}`
      : homeUrl
        ? `Use it here: ${homeUrl}`
        : "Use it on the LinkDrop home page.",
    "",
    description ? "Your request:" : null,
    description ? description : null,
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


