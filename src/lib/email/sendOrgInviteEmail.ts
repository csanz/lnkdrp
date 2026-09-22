/**
 * Sends a workspace invite.
 *
 * This used to hand-roll its own `fetch` to Resend, which made it the one sender in the codebase
 * that ignored `EMAIL_TRANSPORT=console` — so every local run that touched the invite route mailed
 * a real person. It goes through `sendTextEmail` like everything else now, which also means it
 * honours the `from` fallbacks and the redaction in the failure log.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { orgInviteEmail } from "@/lib/email/templates/orgInvite";
import { workspaceForEmail } from "@/lib/email/workspaceIdentity";

type SendOrgInviteEmailParams = {
  to: string;
  orgName: string;
  inviteUrl: string;
  role: string;
  invitedByEmail?: string | null;
  /** Resolves the workspace's avatar for the header; the name already comes from `orgName`. */
  orgId?: string | null;
};

export async function sendOrgInviteEmail(params: SendOrgInviteEmailParams): Promise<void> {
  const { subject, text, html } = orgInviteEmail({
    orgName: params.orgName,
    inviteUrl: params.inviteUrl,
    role: params.role,
    invitedByEmail: params.invitedByEmail ?? null,
    workspace: (await workspaceForEmail(params.orgId)) ?? { name: params.orgName, avatarUrl: null },
  });
  await sendTextEmail({
    to: params.to,
    subject,
    text,
    ...(html ? { html } : {}),
    // Invites kept their own From long before NOTIFICATION_EMAIL_FROM existed; preserved so an
    // operator who configured one does not find invites silently coming from somewhere else.
    from: (process.env.INVITE_EMAIL_FROM ?? "").trim() || null,
  });
}
