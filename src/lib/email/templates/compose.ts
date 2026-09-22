/**
 * How a transactional template turns into a message.
 *
 * Templates describe blocks; this renders them to both bodies and appends the sign-off. They do not
 * write markup, which is what keeps the text part honest: the same array produces both, so a link
 * cannot exist in the HTML and be missing from the plain-text fallback.
 *
 * The footer here is the signature and nothing else. Notifications owe the reader a reason and an
 * unsubscribe — `viewNotifications.ts` passes those — but a welcome or a download approval has no
 * "off" to offer, and a footer implying otherwise would be a dead promise.
 */
import { renderHtml, renderText, type Block, type EmailWorkspace } from "@/lib/email/layout";
import { EMAIL_SIGNATURE } from "./signature";

export type EmailContent = {
  subject: string;
  text: string;
  /** Every transactional template has one now; the type keeps it optional for older callers. */
  html?: string;
};

export function transactional(params: {
  subject: string;
  /**
   * The grey line after the subject in an inbox list. Worth setting: left empty, clients pull the
   * first words of the body, which for these is usually the greeting and says nothing.
   */
  preheader?: string;
  blocks: readonly Block[];
  /**
   * The workspace this is about, shown in the header.
   *
   * Omitted by the emails that are about an account rather than a workspace — `welcome` and
   * `waitlist_approved` arrive before there is a workspace worth naming.
   */
  workspace?: EmailWorkspace | null;
}): EmailContent {
  const footer = { signature: EMAIL_SIGNATURE };
  const workspace = params.workspace ?? null;
  return {
    subject: params.subject,
    text: renderText(params.blocks, footer, workspace),
    html: renderHtml({
      subject: params.subject,
      preheader: params.preheader ?? "",
      blocks: params.blocks,
      footer,
      workspace,
    }),
  };
}

/** Drops blocks whose content turned out to be missing, so callers can inline conditionals. */
export function blocks(...items: Array<Block | null | false | undefined>): Block[] {
  return items.filter((b): b is Block => Boolean(b));
}
