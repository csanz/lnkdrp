/**
 * Senders for the two emails around a reader introducing themselves on a share link.
 *
 * `sendViewerVerifyEmail` goes to the reader, `sendViewerIntroducedEmail` to the document's owner.
 * Both are best-effort: an introduction is already recorded by the time these run, so a mail
 * provider having a bad minute must not turn it into an error the reader sees.
 *
 * The bodies live in `templates/viewerIntroduction.ts` with every other email we send, so they can
 * be read and tested without going through the route that sends them.
 */
import { sendEmailContent } from "@/lib/email/sendTextEmail";
import { viewerIntroducedEmail, viewerVerifyEmail } from "@/lib/email/templates";
import { workspaceForEmail } from "@/lib/email/workspaceIdentity";

type SendViewerVerifyEmailParams = {
  to: string;
  /** What the reader is reading, for a subject they recognise. */
  documentTitle?: string | null;
  /** Who shared it, when the workspace has a name worth showing. */
  workspaceName?: string | null;
  /** Resolves the workspace avatar for the header. */
  orgId?: string | null;
  verifyUrl: string;
};

export async function sendViewerVerifyEmail(params: SendViewerVerifyEmailParams): Promise<void> {
  const content = viewerVerifyEmail({
    documentTitle: params.documentTitle,
    workspaceName: params.workspaceName,
    workspace: await workspaceForEmail(params.orgId),
    verifyUrl: params.verifyUrl,
  });
  await sendEmailContent({ to: params.to, ...content });
}

type SendViewerIntroducedEmailParams = {
  to: string;
  documentTitle?: string | null;
  viewerName?: string | null;
  viewerEmail: string;
  verified: boolean;
  /** Where the owner goes to see the reading itself. */
  metricsUrl?: string | null;
  /** Which workspace the reading happened in. */
  orgId?: string | null;
};

export async function sendViewerIntroducedEmail(params: SendViewerIntroducedEmailParams): Promise<void> {
  const workspace = await workspaceForEmail(params.orgId);
  const content = viewerIntroducedEmail({
    documentTitle: params.documentTitle,
    viewerName: params.viewerName,
    viewerEmail: params.viewerEmail,
    verified: params.verified,
    metricsUrl: params.metricsUrl,
    workspace,
  });
  await sendEmailContent({ to: params.to, ...content });
}
